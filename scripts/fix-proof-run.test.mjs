import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseResultLine } from "../packages/fix-proof/src/result-line.ts";
import { decodeReport, encodeReport } from "../packages/fix-proof/src/transport.ts";

const script = path.join(import.meta.dirname, "fix-proof-run.sh");
const base = "a".repeat(40);
const head = "b".repeat(40);
const echoArgs = "console.log(process.argv.slice(2).join(' '));\n";

describe("fix-proof-run.sh", () => {
  let tmp;
  let runner;
  let dist;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "fix-proof-run-"));
    runner = path.join(tmp, "runner");
    dist = path.join(runner, "packages/fix-proof/dist");
    mkdirSync(dist, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const sh = (args, env = {}) => spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  const readOutputs = (file) =>
    Object.fromEntries(readFileSync(file, "utf8").trimEnd().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));

  describe("judge", () => {
    const judge = () => sh(["judge", runner, path.join(tmp, "repo"), base, head, path.join(tmp, "reports")]);

    it("prints the skipped line when the merge base has bin.js but no judge.js", () => {
      writeFileSync(path.join(dist, "bin.js"), echoArgs);

      const result = judge();

      expect(result.status).toBe(0);
      expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(1);
      const parsed = parseResultLine(result.stdout.trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.result).toMatchObject({ head, mergeBase: base, verdict: "error", error: "skipped: no runner at merge base" });
    });

    it("prints the skipped line when the runner directory itself is missing", () => {
      rmSync(runner, { recursive: true });

      const result = judge();

      expect(result.status).toBe(0);
      expect(parseResultLine(result.stdout.trim()).ok).toBe(true);
    });

    it("runs the merge-base judge.js on the repo and the three report files", () => {
      writeFileSync(path.join(dist, "bin.js"), echoArgs);
      writeFileSync(path.join(dist, "judge.js"), echoArgs);

      const result = judge();

      const reports = path.join(tmp, "reports");
      expect(result.stdout.trim()).toBe(
        `--repo ${path.join(tmp, "repo")} --base ${base} --head ${head} --base-report ${reports}/base.report ` +
          `--base-rerun-report ${reports}/base-rerun.report --head-report ${reports}/head.report`,
      );
    });
  });

  describe("exec", () => {
    const out = () => path.join(tmp, "out");
    const exec = (side) => sh(["exec", side, runner, path.join(tmp, "repo"), base, head, out()]);

    it("writes a skipped marker for each base report when the merge base has no judge.js", () => {
      writeFileSync(path.join(dist, "bin.js"), echoArgs);

      const result = exec("base");

      expect(result.status).toBe(0);
      for (const name of ["base", "base-rerun"]) {
        const decoded = decodeReport(readFileSync(path.join(out(), `${name}.report`), "utf8"));
        expect(decoded).toEqual({ ok: false, error: "skipped: no runner at merge base", reported: true });
      }
    });

    it("runs the merge-base bin's exec for one side under the job's budget", () => {
      writeFileSync(path.join(dist, "bin.js"), echoArgs);
      writeFileSync(path.join(dist, "judge.js"), echoArgs);

      const result = exec("head");

      expect(result.stdout.trim()).toBe(`exec --side head --repo ${path.join(tmp, "repo")} --base ${base} --head ${head} --out ${out()} --budget-ms 780000`);
    });

    it("refuses a side other than base or head", () => {
      expect(exec("other").status).toBe(64);
    });

    describe("base side sandbox", () => {
      let shims;
      let sudoLog;
      let tools;
      // sudo shim: logs each call, runs the root shell that stages pnpm, and exits with the code an env var names so a
      // test can fail one step.
      const sudoShim = `#!/usr/bin/env bash
echo "$*" >>"$SUDO_LOG"
case "$*" in
  "-n true") exit "\${SUDO_TRUE_EXIT:-0}" ;;
  "-n useradd "*) exit "\${USERADD_EXIT:-0}" ;;
  "-n -u fix-proof-sandbox sudo -n true") exit "\${SANDBOX_SUDO_EXIT:-1}" ;;
  "-n sh -c "*) shift; exec "$@" ;;
esac
exit 0
`;
      // id shim: the sandbox user is absent until useradd, and has only its own group unless a test says otherwise.
      const idShim = `#!/usr/bin/env bash
case "$1" in
  -u) exit "\${SANDBOX_ID_EXIT:-1}" ;;
  -G) echo "\${SANDBOX_GROUPS:-999}" ;;
  -g) echo 999 ;;
esac
`;
      // Laid out as pnpm/action-setup leaves it: a .bin shim beside node_modules/pnpm.
      const installPnpm = () => {
        const pkg = path.join(tmp, "setup-pnpm/node_modules/pnpm");
        mkdirSync(path.join(pkg, "bin"), { recursive: true });
        writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "pnpm", bin: { pnpm: "bin/pnpm.cjs", pnpx: "bin/pnpx.cjs" } }));
        writeFileSync(path.join(pkg, "bin/pnpm.cjs"), "console.log(`pnpm at ${__filename} ${process.argv.slice(2).join(' ')}`);\n");
        const bin = path.join(tmp, "setup-pnpm/node_modules/.bin");
        mkdirSync(bin);
        writeFileSync(path.join(bin, "pnpm"), `#!/bin/sh\nexec node ${path.join(pkg, "bin/pnpm.cjs")} "$@"\n`, { mode: 0o755 });
        return bin;
      };
      // Prints its args, then which pnpm a sandboxed `pnpm exec` would get from the PATH the runner forwards.
      const binJs = `${echoArgs}console.log(require("node:child_process").execFileSync("pnpm", ["exec"], { encoding: "utf8" }).trim());\n`;
      let searchPath;
      beforeEach(() => {
        shims = path.join(tmp, "shims");
        sudoLog = path.join(tmp, "sudo.log");
        tools = path.join(tmp, "opt/fix-proof-sandbox");
        mkdirSync(shims);
        writeFileSync(path.join(shims, "sudo"), sudoShim, { mode: 0o755 });
        writeFileSync(path.join(shims, "id"), idShim, { mode: 0o755 });
        for (const tool of ["unshare", "setpriv", "timeout"]) writeFileSync(path.join(shims, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        searchPath = `${shims}:${installPnpm()}:${process.env.PATH}`;
        writeFileSync(path.join(dist, "bin.js"), binJs);
        writeFileSync(path.join(dist, "judge.js"), echoArgs);
      });
      const withSandboxSupport = () => writeFileSync(path.join(dist, "chunk-ABC.js"), 'var SANDBOX_FLAG = "sandbox-user";\n');
      const execWith = (side, env = {}) =>
        sh(["exec", side, runner, path.join(tmp, "repo"), base, head, out()], { PATH: searchPath, SUDO_LOG: sudoLog, FIX_PROOF_SANDBOX_TOOLS: tools, ...env });
      const expectBaseMarkers = (error) => {
        for (const name of ["base", "base-rerun"]) {
          const decoded = decodeReport(readFileSync(path.join(out(), `${name}.report`), "utf8"));
          expect(decoded).toEqual({ ok: false, error, reported: true });
        }
      };

      it("exec base on a runner with sandbox support passes --sandbox-user fix-proof-sandbox", () => {
        withSandboxSupport();

        const result = execWith("base");

        expect(result.status).toBe(0);
        expect(result.stdout.split("\n")[0]).toBe(
          `exec --side base --repo ${path.join(tmp, "repo")} --base ${base} --head ${head} --out ${out()} --budget-ms 780000 --sandbox-user fix-proof-sandbox`,
        );
        expect(readFileSync(sudoLog, "utf8")).toContain("-n -u fix-proof-sandbox sudo -n true");
      });

      it("exec base runs pnpm from a copy outside the runner's home, which the sandbox user cannot traverse", () => {
        withSandboxSupport();

        const result = execWith("base");

        expect(result.status).toBe(0);
        expect(result.stdout.split("\n")[1]).toBe(`pnpm at ${path.join(tools, "pnpm/bin/pnpm.cjs")} exec`);
      });

      it("exec base writes error markers when pnpm cannot be staged for the sandbox", () => {
        withSandboxSupport();
        rmSync(path.join(tmp, "setup-pnpm/node_modules/pnpm/package.json"));

        const result = execWith("base");

        expect(result.stdout).toBe("");
        expectBaseMarkers("base: sandbox unavailable: staging pnpm for the sandbox failed");
      });

      it("exec base writes error markers when an existing sandbox user has supplementary groups", () => {
        withSandboxSupport();

        const result = execWith("base", { SANDBOX_ID_EXIT: "0", SANDBOX_GROUPS: "999 118" });

        expect(result.stdout).toBe("");
        expectBaseMarkers("base: sandbox unavailable: fix-proof-sandbox has supplementary groups");
      });

      it("exec base on a merge-base runner without sandbox support writes error markers for both base reports", () => {
        const result = execWith("base");

        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expectBaseMarkers("base: sandbox unavailable: the merge-base runner has no sandbox support");
      });

      it("exec base writes error markers when the sandbox user can sudo", () => {
        withSandboxSupport();

        const result = execWith("base", { SANDBOX_SUDO_EXIT: "0" });

        expect(result.stdout).toBe("");
        expectBaseMarkers("base: sandbox unavailable: fix-proof-sandbox can sudo");
      });

      it("exec base writes error markers when the job cannot sudo, rather than reading a failed sudo check as safe", () => {
        withSandboxSupport();

        const result = execWith("base", { SUDO_TRUE_EXIT: "1" });

        expect(result.stdout).toBe("");
        expectBaseMarkers("base: sandbox unavailable: the job cannot sudo");
      });

      it("exec base writes error markers when the sandbox user cannot be created", () => {
        withSandboxSupport();

        const result = execWith("base", { USERADD_EXIT: "1" });

        expect(result.stdout).toBe("");
        expectBaseMarkers("base: sandbox unavailable: useradd failed");
      });

      it("exec head never passes --sandbox-user and never touches sudo", () => {
        withSandboxSupport();

        const result = execWith("head");

        expect(result.stdout.split("\n")[0]).not.toContain("sandbox-user");
        expect(result.stdout).not.toContain(tools);
        expect(existsSync(sudoLog)).toBe(false);
      });
    });
  });

  describe("emit and receive", () => {
    const out = () => path.join(tmp, "out");
    const outputFile = () => path.join(tmp, "github-output");
    const emit = (side) => sh(["emit", side, out()], { GITHUB_OUTPUT: outputFile() });
    const report = encodeReport({ testResults: [{ name: "src/a.test.ts", status: "failed", assertionResults: [] }] });
    beforeEach(() => mkdirSync(out()));

    it("passes the base reports as report and rerun, and receive writes them back byte for byte", () => {
      writeFileSync(path.join(out(), "base.report"), report);
      writeFileSync(path.join(out(), "base-rerun.report"), report);

      expect(emit("base").status).toBe(0);
      const outputs = readOutputs(outputFile());
      const received = path.join(tmp, "reports");
      const env = { REPORT_BASE: JSON.stringify(outputs.report), REPORT_BASE_RERUN: JSON.stringify(outputs.rerun), REPORT_HEAD: '""' };
      expect(sh(["receive", received], env).status).toBe(0);

      expect(readFileSync(path.join(received, "base.report"), "utf8")).toBe(report);
      expect(readFileSync(path.join(received, "base-rerun.report"), "utf8")).toBe(report);
      expect(existsSync(path.join(received, "head.report"))).toBe(false);
    });

    it("replaces a report that would add lines to GITHUB_OUTPUT with an error marker", () => {
      writeFileSync(path.join(out(), "head.report"), `${report}\nrerun=forged`);

      emit("head");

      const outputs = readOutputs(outputFile());
      expect(Object.keys(outputs)).toEqual(["report"]);
      expect(decodeReport(outputs.report)).toEqual({ ok: false, error: "head: report is not base64", reported: true });
    });

    it("replaces a report too large for one environment string with an error marker", () => {
      writeFileSync(path.join(out(), "head.report"), "A".repeat(120_001));

      emit("head");

      const decoded = decodeReport(readOutputs(outputFile()).report);
      expect(decoded).toMatchObject({ ok: false, reported: true, error: expect.stringContaining("too large") });
    });

    it("marks a report the exec job never wrote", () => {
      emit("head");

      expect(decodeReport(readOutputs(outputFile()).report)).toMatchObject({ ok: false, error: "head: the exec job wrote no report" });
    });

    it("leaves a forged escaped value undecodable rather than unescaping it", () => {
      const received = path.join(tmp, "reports");
      sh(["receive", received], { REPORT_HEAD: JSON.stringify(`${report}\nfix-proof/v1 {}`) });

      expect(decodeReport(readFileSync(path.join(received, "head.report"), "utf8")).ok).toBe(false);
    });
  });
});

describe("fix-proof workflow", () => {
  const text = readFileSync(path.join(import.meta.dirname, "../.github/workflows/fix-proof.yml"), "utf8");
  const workflow = parse(text);
  const judge = workflow.jobs["fix-proof"];

  it("only the judge job is named fix-proof", () => {
    const named = Object.entries(workflow.jobs).filter(([id, job]) => (job.name ?? id) === "fix-proof");

    expect(named.map(([id]) => id)).toEqual(["fix-proof"]);
    expect(Object.keys(workflow.jobs).sort()).toEqual(["fix-proof", "fix-proof-base", "fix-proof-head"]);
  });

  it("only the head exec job restores or saves a cache, so a store its install tampered with reaches no base-side or judge job", () => {
    const caches = (job) => job.steps.some((step) => Object.keys(step.with ?? {}).some((key) => /cache/.test(key)) || /cache/.test(step.uses ?? ""));

    const cached = Object.entries(workflow.jobs).filter(([, job]) => caches(job));

    expect(cached.map(([id]) => id)).toEqual(["fix-proof-head"]);
  });

  it.each(["fix-proof-base", "fix-proof"])("%s takes pnpm, node and their config only from the merge-base runner tree", (id) => {
    const steps = workflow.jobs[id].steps;
    const index = (match) => steps.findIndex(match);

    const headCheckout = steps.find((step) => step.with?.ref === "${{ github.event.pull_request.head.sha }}");
    const pnpmSetup = index((step) => step.uses?.startsWith("pnpm/action-setup@"));
    const nodeSetup = index((step) => step.uses?.startsWith("actions/setup-node@"));
    const runnerTree = index((step) => /worktree add --detach "\$GITHUB_WORKSPACE\/runner"/.test(step.run ?? ""));

    expect(headCheckout.with.path).toBe("src");
    expect(steps[pnpmSetup].with).toEqual({ package_json_file: "runner/package.json" });
    expect(steps[nodeSetup].with).toEqual({ "node-version-file": "runner/.node-version" });
    expect(runnerTree).toBeGreaterThan(-1);
    expect(runnerTree).toBeLessThan(Math.min(pnpmSetup, nodeSetup));
    expect(steps.filter((step) => step.uses?.startsWith("actions/checkout@")).every((step) => step.with?.path !== undefined)).toBe(true);
    expect(steps.every((step) => step["working-directory"] === undefined || step["working-directory"] === "runner")).toBe(true);
    expect(steps.some((step) => /\bcorepack\b/.test(step.run ?? ""))).toBe(false);
  });

  it("the judge job has no cache and installs only from the runner tree", () => {
    expect(judge.needs).toEqual(["fix-proof-base", "fix-proof-head"]);
    expect(judge.if).toBe("${{ !cancelled() }}");
    expect(judge.steps.some((step) => step.with !== undefined && "cache" in step.with)).toBe(false);
    expect(judge.steps.every((step) => step["working-directory"] === undefined || step["working-directory"] === "runner")).toBe(true);
    const setup = judge.steps.filter((step) => /^(pnpm\/action-setup|actions\/setup-node)@/.test(step.uses ?? ""));
    expect(setup.map((step) => step.with)).toEqual([{ package_json_file: "runner/package.json" }, { "node-version-file": "runner/.node-version" }]);
    const install = judge.steps.find((step) => /pnpm install/.test(step.run ?? ""));
    expect(install["working-directory"]).toBe("runner");
  });

  it("the judge receives each exec job's output through toJSON, never interpolated into a script", () => {
    const receive = judge.steps.find((step) => step.env?.REPORT_HEAD !== undefined);

    expect(receive.env).toEqual({
      REPORT_BASE: "${{ toJSON(needs.fix-proof-base.outputs.report) }}",
      REPORT_BASE_RERUN: "${{ toJSON(needs.fix-proof-base.outputs.rerun) }}",
      REPORT_HEAD: "${{ toJSON(needs.fix-proof-head.outputs.report) }}",
    });
    const runs = Object.values(workflow.jobs).flatMap((job) => job.steps.map((step) => step.run ?? ""));
    expect(runs.some((run) => run.includes("${{"))).toBe(false);
  });

  it("each exec job passes its emitted reports on as job outputs", () => {
    expect(workflow.jobs["fix-proof-base"].outputs).toEqual({ report: "${{ steps.emit.outputs.report }}", rerun: "${{ steps.emit.outputs.rerun }}" });
    expect(workflow.jobs["fix-proof-head"].outputs).toEqual({ report: "${{ steps.emit.outputs.report }}" });
  });

  it("runs the script from the workflow's own commit, not from the PR head checkout", () => {
    expect(text).toContain("ref: ${{ github.sha }}");
    expect(text).toMatch(/bash \.fix-proof-workflow\/scripts\/fix-proof-run\.sh /);
    expect(text).not.toMatch(/bash scripts\/fix-proof-run\.sh/);
  });
});
