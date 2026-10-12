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
    const exec = (side) => sh(["exec", side, runner, base, head, out()]);

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

      expect(result.stdout.trim()).toBe(`exec --side head --base ${base} --head ${head} --out ${out()} --budget-ms 780000`);
    });

    it("refuses a side other than base or head", () => {
      expect(exec("other").status).toBe(64);
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
    const caches = (job) => job.steps.some((step) => (step.with !== undefined && "cache" in step.with) || /^actions\/cache\b/.test(step.uses ?? ""));

    const cached = Object.entries(workflow.jobs).filter(([, job]) => caches(job));

    expect(cached.map(([id]) => id)).toEqual(["fix-proof-head"]);
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
