import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GIT_SAFETY } from "./context.js";
import { spawnExec, type Exec } from "./exec.js";
import { FIXED, git, makeRepo, REAL_RUNNER, REAL_TEST, removeRepos } from "./repo.test-helpers.js";
import { isSandboxed, sudoStub, type StubOptions } from "./sandbox.test-helpers.js";
import { execSide, MAX_VITEST_REPORT_BYTES } from "./side.js";
import { decodeReport } from "./transport.js";

const outs: string[] = [];

// Keyed on the runner contract, not the command text, so it holds for the fake runner too.
const runsUnsandboxed = (call: { file: string; args: readonly string[] }) => call.file === "sh" && call.args.includes("--outputFile");

function outDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-proof-side-"));
  outs.push(dir);
  return dir;
}

function replaceOutput(args: readonly string[], plant: (output: string) => void): void {
  const output = args[args.indexOf("--outputFile") + 1] ?? "";
  fs.rmSync(output, { force: true });
  plant(output);
}

async function sandboxedBase(options: StubOptions) {
  const stub = sudoStub(options);
  const repo = makeRepo();
  const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });
  const out = outDir();
  await execSide({ repo: repo.dir, base: repo.base, head, side: "base", out, exec: stub.exec, sandboxUser: "fix-proof-sandbox" });
  return { calls: stub.calls, reports: readReports(out, ["base", "base-rerun"]) };
}

function readReports(out: string, names: readonly string[]) {
  return names.map((name) => decodeReport(fs.readFileSync(path.join(out, `${name}.report`), "utf-8")));
}

/** An executable that records it ran by creating `<dir>/ran`, then fails as a hostile fsmonitor or hook would be free to. */
function markerScript(dir: string): { script: string; ran: string } {
  const script = path.join(dir, "marker.sh");
  const ran = path.join(dir, "ran");
  fs.writeFileSync(script, `#!/bin/sh\ntouch '${ran}'\nexit 1\n`, { mode: 0o755 });
  return { script, ran };
}

/** A head test file whose top-level code runs `plant` in the base side's tree before its "adds" test. */
function plantingTest(plant: string): string {
  return ['import { execFileSync, spawnSync } from "node:child_process";', 'import * as fs from "node:fs";', plant, REAL_TEST].join("\n");
}

// The base side runs the head's test code first, so whatever it plants in the shared .git is there for the head side.
async function baseThenHead(files: Record<string, string>) {
  const repo = makeRepo(REAL_RUNNER);
  const head = repo.commit({ "src/math.ts": FIXED, ...files });
  const out = outDir();
  await execSide({ repo: repo.dir, base: repo.base, head, side: "base", out });
  await execSide({ repo: repo.dir, base: repo.base, head, side: "head", out });
  return { repo, reports: readReports(out, ["base", "head"]) };
}

// A runner's environment can carry its own core.hooksPath (GIT_CONFIG_COUNT), which would mask a hook the repo enables.
async function withoutEnvGitConfig<T>(body: () => Promise<T>): Promise<T> {
  const saved = Object.entries(process.env).filter(([key]) => key.startsWith("GIT_CONFIG"));
  saved.forEach(([key]) => delete process.env[key]);
  try {
    return await body();
  } finally {
    saved.forEach(([key, value]) => (process.env[key] = value));
  }
}

afterEach(() => {
  removeRepos();
  outs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

describe("execSide", { timeout: 120_000 }, () => {
  it("base side runs install and build before any head file exists in the tree", async () => {
    const listing = outDir();
    const repo = makeRepo({ build: `find . -path ./.git -prune -o -type f -print > ${listing}/tree.txt` });
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST, "src/test-support/three.ts": "export const three = 3;\n" });

    await execSide({ repo: repo.dir, base: repo.base, head, side: "base", out: outDir() });

    const files = fs.readFileSync(path.join(listing, "tree.txt"), "utf-8");
    expect(files).toContain("./src/math.ts");
    expect(files).not.toContain("math.test.ts");
    expect(files).not.toContain("test-support");
  });

  it("base side writes two reports with repo-relative file names", async () => {
    const repo = makeRepo(REAL_RUNNER);
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });
    const out = outDir();

    await execSide({ repo: repo.dir, base: repo.base, head, side: "base", out });

    expect(fs.readdirSync(out).sort()).toEqual(["base-rerun.report", "base.report"]);
    const decoded = decodeReport(fs.readFileSync(path.join(out, "base.report"), "utf-8"));
    expect(decoded.ok && decoded.report.testResults).toMatchObject([{ name: "src/math.test.ts", status: "failed" }]);
  });

  it("a failed head build writes an error marker instead of throwing", async () => {
    const repo = makeRepo({ build: "exit 3" });
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });
    const out = outDir();

    await execSide({ repo: repo.dir, base: repo.base, head, side: "head", out });

    expect(decodeReport(fs.readFileSync(path.join(out, "head.report"), "utf-8"))).toEqual({
      ok: false,
      error: "head: build failed (exit 3)",
      reported: true,
    });
  });

  it("three head runs build once and write three reports", async () => {
    const calls: string[][] = [];
    const exec: Exec = (file, args, options) => {
      calls.push([file, ...args]);
      return spawnExec(file, args, options);
    };
    const repo = makeRepo({ build: "echo building" });
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });
    const out = outDir();

    await execSide({ repo: repo.dir, base: repo.base, head, side: "head", out, exec, headRuns: 3 });

    expect(fs.readdirSync(out).sort()).toEqual(["head-2.report", "head-3.report", "head.report"]);
    expect(calls.filter((call) => call.some((arg) => arg.startsWith("echo building")))).toHaveLength(1);
    expect(calls.filter((call) => call.includes("--outputFile"))).toHaveLength(3);
    readReports(out, ["head", "head-2", "head-3"]).forEach((report) => expect(report.ok).toBe(true));
  });

  it("no head runs set writes only head.report, byte-identical", async () => {
    const repo = makeRepo();
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });
    const [unset, one] = [outDir(), outDir()];

    await execSide({ repo: repo.dir, base: repo.base, head, side: "head", out: unset });
    await execSide({ repo: repo.dir, base: repo.base, head, side: "head", out: one, headRuns: 1 });

    expect(fs.readdirSync(unset)).toEqual(["head.report"]);
    expect(fs.readFileSync(path.join(one, "head.report"))).toEqual(fs.readFileSync(path.join(unset, "head.report")));
  });

  it.each([0, 6, 1.5])("headRuns %s writes error markers", async (headRuns) => {
    const repo = makeRepo();
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });
    const out = outDir();

    await execSide({ repo: repo.dir, base: repo.base, head, side: "head", out, headRuns });

    const [report] = readReports(out, ["head"]);
    expect(report).toMatchObject({ ok: false, reported: true });
    expect(report?.ok === false && report.error).toContain("headRuns must be an integer from 1 to 5");
  });

  it("a failed head build writes an error marker to every run's report", async () => {
    const repo = makeRepo({ build: "exit 3" });
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });
    const out = outDir();

    await execSide({ repo: repo.dir, base: repo.base, head, side: "head", out, headRuns: 3 });

    readReports(out, ["head", "head-2", "head-3"]).forEach((report) =>
      expect(report).toEqual({ ok: false, error: "head: build failed (exit 3)", reported: true }),
    );
  });

  it("execSide resolves when its out dir cannot be created", async () => {
    const repo = makeRepo();
    const head = repo.commit({ "src/math.ts": FIXED });
    const blocker = path.join(outDir(), "file");
    fs.writeFileSync(blocker, "");

    await expect(execSide({ repo: repo.dir, base: repo.base, head, side: "head", out: path.join(blocker, "sub") })).resolves.toBeUndefined();
  });

  it("every git call the base side makes ignores replace refs and pathspec magic", async () => {
    const calls: (readonly string[])[] = [];
    const exec: Exec = (file, args, options) => {
      if (file === "git") calls.push(args);
      return spawnExec(file, args, options);
    };
    const repo = makeRepo();
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST, "src/test-support/three.ts": "export const three = 3;\n" });

    await execSide({ repo: repo.dir, base: repo.base, head, side: "base", out: outDir(), exec });

    const subcommand = (args: readonly string[]) => args.find((arg, index) => !arg.startsWith("-") && args[index - 1] !== "-c");
    expect(calls.map(subcommand)).toEqual(expect.arrayContaining(["worktree", "checkout"]));
    calls.forEach((args) => expect(args.slice(0, GIT_SAFETY.length)).toEqual([...GIT_SAFETY]));
  });

  it("a core.fsmonitor that head test code plants on the base side never runs in the head side's worktree add", async () => {
    const marker = markerScript(outDir());
    const plant = `execFileSync("git", ["config", "core.fsmonitor", ${JSON.stringify(marker.script)}]);`;

    const { repo, reports } = await baseThenHead({ "src/math.test.ts": plantingTest(plant) });

    expect(git(repo.dir, ["config", "--get", "core.fsmonitor"])).toBe(marker.script);
    expect(reports[1]?.ok && reports[1].report.testResults).toMatchObject([{ name: "src/math.test.ts", status: "passed" }]);
    expect(fs.existsSync(marker.ran)).toBe(false);
  });

  it("a post-checkout hook that head test code plants on the base side never runs in the head side's worktree add", async () => {
    const marker = markerScript(outDir());
    const plant = [
      'spawnSync("git", ["config", "--unset", "core.hooksPath"]);',
      'const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf-8" }).trim();',
      'fs.mkdirSync(`${common}/hooks`, { recursive: true });',
      `fs.copyFileSync(${JSON.stringify(marker.script)}, \`\${common}/hooks/post-checkout\`);`,
      'fs.chmodSync(`${common}/hooks/post-checkout`, 0o755);',
    ].join("\n");

    const { repo, reports } = await withoutEnvGitConfig(() => baseThenHead({ "src/math.test.ts": plantingTest(plant) }));

    expect(spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], { cwd: repo.dir }).status).toBe(1);
    expect(fs.existsSync(path.join(repo.dir, ".git", "hooks", "post-checkout"))).toBe(true);
    expect(reports[1]?.ok && reports[1].report.testResults).toMatchObject([{ name: "src/math.test.ts", status: "passed" }]);
    expect(fs.existsSync(marker.ran)).toBe(false);
  });

  it("a head test file named with pathspec magic overlays only itself", async () => {
    const repo = makeRepo(REAL_RUNNER);
    const name = ":(exclude)x.test.ts";
    const head = repo.commit({ "src/math.ts": FIXED, [name]: REAL_TEST.replace('"./math"', '"./src/math"') });
    const out = outDir();

    await execSide({ repo: repo.dir, base: repo.base, head, side: "base", out });

    const [base] = readReports(out, ["base"]);
    expect(base?.ok && base.report.testResults).toMatchObject([{ name, status: "failed" }]);
  });

  it("the plan's git diff runs no external diff or textconv program", async () => {
    const calls: (readonly string[])[] = [];
    const exec: Exec = (file, args, options) => {
      if (file === "git") calls.push(args);
      return spawnExec(file, args, options);
    };
    const repo = makeRepo();
    const head = repo.commit({ "src/math.ts": FIXED });

    await execSide({ repo: repo.dir, base: repo.base, head, side: "head", out: outDir(), exec });

    const diff = calls.find((args) => args.includes("diff"));
    expect(diff).toEqual(expect.arrayContaining(["--no-ext-diff", "--no-textconv"]));
  });

  it("base side with a sandbox user runs every vitest call through the sandbox and chowns the tree first", async () => {
    const { calls, exec } = sudoStub();
    const repo = makeRepo(REAL_RUNNER);
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });
    const out = outDir();

    await execSide({ repo: repo.dir, base: repo.base, head, side: "base", out, exec, sandboxUser: "fix-proof-sandbox", budgetMs: 120_000 });

    const chownTree = calls.findIndex((call) => call.file === "sudo" && call.args.includes("find"));
    const vitest = calls.flatMap((call, index) => (isSandboxed(call) ? [index] : []));
    expect(chownTree).toBeGreaterThanOrEqual(0);
    expect(vitest).toHaveLength(2);
    expect(chownTree).toBeLessThan(vitest[0] ?? -1);
    expect(calls.some(runsUnsandboxed)).toBe(false);
    expect(calls.filter((call) => call.file === "sudo").at(-1)?.args.slice(0, 4)).toEqual(["-n", "--", "chown", "-R"]);
    const seconds = Number(calls[vitest[0] ?? 0]?.args[5]);
    expect(seconds).toBeGreaterThan(60);
    expect(seconds).toBeLessThanOrEqual(120);
    const reports = readReports(out, ["base", "base-rerun"]);
    reports.forEach((report) => expect(report.ok && report.report.testResults).toMatchObject([{ name: "src/math.test.ts", status: "failed" }]));
  });

  it("sandbox setup failure writes error markers, and vitest never runs unsandboxed", async () => {
    const { calls, exec } = sudoStub({ failing: (args) => args.includes("find") });
    const repo = makeRepo();
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });
    const out = outDir();

    await execSide({ repo: repo.dir, base: repo.base, head, side: "base", out, exec, sandboxUser: "fix-proof-sandbox" });

    readReports(out, ["base", "base-rerun"]).forEach((report) =>
      expect(report).toEqual({ ok: false, error: expect.stringMatching(/^base: sandbox setup failed/), reported: true }),
    );
    expect(calls.some(isSandboxed)).toBe(false);
    expect(calls.some(runsUnsandboxed)).toBe(false);
  });

  it("a symlinked vitest output is not read", async () => {
    const forged = path.join(outDir(), "forged.json");
    fs.writeFileSync(forged, JSON.stringify({ testResults: [] }));

    const { reports } = await sandboxedBase({ after: (args) => replaceOutput(args, (output) => fs.symlinkSync(forged, output)) });

    expect(reports[0]).toEqual({ ok: false, error: expect.stringMatching(/^base: vitest wrote no report/), reported: true });
  });

  it("a FIFO in place of the vitest output is refused without blocking", async () => {
    const { reports } = await sandboxedBase({ after: (args) => replaceOutput(args, (output) => execFileSync("mkfifo", [output])) });

    expect(reports[0]).toEqual({ ok: false, error: expect.stringMatching(/^base: vitest wrote no report/), reported: true });
  });

  it("a vitest output over the size cap is an error, not a truncated parse", async () => {
    const plant = (output: string) => {
      fs.writeFileSync(output, "{");
      fs.truncateSync(output, MAX_VITEST_REPORT_BYTES + 1);
    };

    const { reports } = await sandboxedBase({ after: (args) => replaceOutput(args, plant) });

    expect(reports[0]).toEqual({ ok: false, error: `base: vitest report over ${MAX_VITEST_REPORT_BYTES} bytes`, reported: true });
  });

  it.each([
    ["root", 0],
    ["the runner's own uid", process.getuid?.() ?? -1],
  ])("a sandbox user that resolves to %s fails closed before any sandboxed call", async (_who, uid) => {
    const { calls, reports } = await sandboxedBase({ uid });

    reports.forEach((report) => expect(report).toEqual({ ok: false, error: expect.stringMatching(/^base: sandbox setup failed .*uid/), reported: true }));
    expect(calls.some((call) => call.file === "sudo" && !call.args.includes("-R"))).toBe(false);
  });

  it("head side ignores the sandbox user", async () => {
    const { calls, exec } = sudoStub();
    const repo = makeRepo();
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });
    const out = outDir();

    await execSide({ repo: repo.dir, base: repo.base, head, side: "head", out, exec, sandboxUser: "fix-proof-sandbox" });

    expect(calls.some((call) => call.file === "sudo")).toBe(false);
    expect(readReports(out, ["head"])[0]?.ok).toBe(true);
  });
});
