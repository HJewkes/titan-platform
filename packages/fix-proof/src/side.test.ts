import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GIT_SAFETY } from "./context.js";
import { spawnExec, type Exec, type ExecResult } from "./exec.js";
import { FIXED, makeRepo, REAL_TEST, removeRepos } from "./repo.test-helpers.js";
import { execSide, MAX_VITEST_REPORT_BYTES } from "./side.js";
import { decodeReport } from "./transport.js";

const outs: string[] = [];

function outDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-proof-side-"));
  outs.push(dir);
  return dir;
}

interface Call {
  file: string;
  args: readonly string[];
}

const isSandboxed = (call: Call) => call.file === "sudo" && call.args.includes("setpriv");

interface StubOptions {
  /** What `id -u` answers for the sandbox user. */
  uid?: number;
  failing?: (args: readonly string[]) => boolean;
  after?: (args: readonly string[]) => void;
}

/**
 * Records every call and stands in for sudo and id without root: a sandboxed call runs the command after setpriv's `--`
 * as this user, and any other sudo call succeeds unless failing says otherwise. after runs once a sandboxed call exits.
 */
function sudoStub({ uid = 4242, failing = () => false, after = () => undefined }: StubOptions = {}) {
  const calls: Call[] = [];
  const exec: Exec = async (file, args, options): Promise<ExecResult> => {
    calls.push({ file, args });
    if (file === "id") return { status: 0, stdout: `${uid}\n`, stderr: "" };
    if (file !== "sudo") return spawnExec(file, args, options);
    if (!args.includes("setpriv")) return { status: failing(args) ? 1 : 0, stdout: "", stderr: "" };
    const command = args.slice(args.indexOf("--", args.indexOf("setpriv")) + 1);
    const result = await spawnExec(command[0] ?? "", command.slice(1), options);
    after(args);
    return result;
  };
  return { calls, exec };
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
    const repo = makeRepo();
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

    expect(calls.map((args) => args.find((arg) => !arg.startsWith("-")))).toEqual(expect.arrayContaining(["worktree", "checkout"]));
    calls.forEach((args) => expect(args.slice(0, GIT_SAFETY.length)).toEqual([...GIT_SAFETY]));
  });

  it("base side with a sandbox user runs every vitest call through the sandbox and chowns the tree first", async () => {
    const { calls, exec } = sudoStub();
    const repo = makeRepo();
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });
    const out = outDir();

    await execSide({ repo: repo.dir, base: repo.base, head, side: "base", out, exec, sandboxUser: "fix-proof-sandbox", budgetMs: 120_000 });

    const chownTree = calls.findIndex((call) => call.file === "sudo" && call.args.includes("find"));
    const vitest = calls.flatMap((call, index) => (isSandboxed(call) ? [index] : []));
    expect(chownTree).toBeGreaterThanOrEqual(0);
    expect(vitest).toHaveLength(2);
    expect(chownTree).toBeLessThan(vitest[0] ?? -1);
    expect(calls.filter((call) => call.file === "sh").map((call) => call.args[1])).not.toContainEqual(expect.stringContaining("vitest"));
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
    expect(calls.filter((call) => call.file === "sh").map((call) => call.args[1])).not.toContainEqual(expect.stringContaining("vitest"));
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
