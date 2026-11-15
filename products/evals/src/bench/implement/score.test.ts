import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { spawnExec, type Exec } from "@titan-design/fix-proof";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOB_SCHEMA, type JobRow } from "../ledger.js";
import { implementTrack, type ImplementCase } from "./job.js";

const CASE_ID = "demo-pr1-implement-abc";
const HIDDEN = "packages/demo/src/a.test.ts";
const OWN_TEST = "packages/demo/src/b.test.ts";
const ARM = { id: "S-high", model: "claude-sonnet-5-5", effort: "high" as const };

let root: string;
let casesDir: string;
let preparedRoot: string;
let runDir: string;

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bench-i-score-"));
  casesDir = join(root, "cases");
  preparedRoot = join(root, "prepared");
  runDir = join(root, "run");
  const base = join(preparedRoot, CASE_ID);
  mkdirSync(join(base, "packages", "demo", "src"), { recursive: true });
  writeFileSync(join(base, "packages", "demo", "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(base, "package.json"), JSON.stringify({ packageManager: "pnpm@9.15.0+sha512.abc" }));
  mkdirSync(join(root, "corepack", "v1", "pnpm", "9.15.0"), { recursive: true });
  writeFileSync(join(root, "corepack", "v1", "pnpm", "9.15.0", "package.json"), "{}");
  git(base, "init", "-q");
  git(base, "add", "-A");
  git(base, "commit", "-q", "-m", "base");
  mkdirSync(join(casesDir, "hidden", CASE_ID, "packages", "demo", "src"), { recursive: true });
  writeFileSync(join(casesDir, "hidden", CASE_ID, HIDDEN), "test('a', () => {});\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const benchCase: ImplementCase = {
  id: CASE_ID,
  hash: "h".repeat(64),
  candidate: "demo-pr1",
  taskId: "TP-1",
  kind: "feature",
  size: "S",
  pkgGroup: "other",
  mergeSha: "d".repeat(40),
  baseSha: "b".repeat(40),
  brief: "Task: add b\nDone when: b exists",
  hiddenTests: [HIDDEN],
  nonTestLines: 4,
};

interface PnpmCall {
  step: string;
  hiddenPresent: boolean;
}

/** git and cp run for real; pnpm steps are faked, and each records whether the hidden test sat in the tree when it ran. */
function fakeExec(outcomes: { hidden: boolean; own: boolean | "flaky" }):{ exec: Exec; pnpm: PnpmCall[] } {
  const pnpm: PnpmCall[] = [];
  const exec: Exec = async (file, args, options) => {
    const command = file === "env" ? args.slice(args.indexOf("timeout") + 4) : [file, ...args];
    if (command[0] !== "pnpm") return spawnExec(command[0] ?? "", command.slice(1), options);
    const outputAt = command.indexOf("--outputFile");
    const step = command.includes(HIDDEN) ? "hidden" : command.includes("--passWithNoTests") ? "own" : command.includes("vitest") ? "own-rerun" : (command.at(-1) ?? "");
    pnpm.push({ step, hiddenPresent: existsSync(join(options.cwd, HIDDEN)) });
    const ok = { hidden: outcomes.hidden, own: outcomes.own === true, "own-rerun": outcomes.own === "flaky" }[step] ?? true;
    if (outputAt >= 0) writeReport(command[outputAt + 1] ?? "", options.cwd, step === "hidden" ? HIDDEN : OWN_TEST, ok);
    return { status: ok ? 0 : 1, stdout: "", stderr: ok ? "" : `${step} failed` };
  };
  return { exec, pnpm };
}

function writeReport(path: string, tree: string, file: string, passed: boolean): void {
  const testResults = [{ name: join(tree, file), status: passed ? "passed" : "failed" }];
  writeFileSync(path, JSON.stringify({ success: passed, numPassedTests: passed ? 1 : 0, numFailedTests: passed ? 0 : 1, testResults }));
}

function jobRow(transcript: string): JobRow {
  const times = { startedAt: "2026-11-01T00:00:00.000Z", endedAt: "2026-11-01T00:01:00.000Z", seconds: 60 } satisfies Partial<JobRow>;
  const meter = { tokens: null, listUsd: null, effortSeen: null, modelSeen: null } satisfies Partial<JobRow>;
  const identity = { schema: JOB_SCHEMA, track: "i" as const, arm: ARM, caseId: CASE_ID, caseHash: benchCase.hash, block: 0, stratum: null, attempt: 1 } satisfies Partial<JobRow>;
  return { ...identity, sessionId: "s1", transcript, ...times, exit: { code: 0, timedOut: false }, outcome: "ok", ...meter };
}

async function runArm(exec: Exec, change: ((ws: string) => void) | undefined, transcript = join(root, "none.jsonl")) {
  const plugin = implementTrack({ casesDir, preparedRoot, runDir, operatorHome: "/work/op", exec, path: process.env.PATH ?? "", corepackHome: join(root, "corepack") });
  mkdirSync(join(root, "job", "home"), { recursive: true });
  const prepared = await plugin.prepare(benchCase, ARM, join(root, "job"));
  const hiddenAtLaunch = existsSync(join(prepared.cwd, HIDDEN));
  if (change !== undefined) change(prepared.cwd);
  const scored = await plugin.score(jobRow(transcript), benchCase, prepared);
  await plugin.cleanup(benchCase, ARM, prepared);
  return { scored, hiddenAtLaunch, prepared };
}

const addB = (ws: string): void => {
  writeFileSync(join(ws, "packages", "demo", "src", "b.ts"), "export const b = 2;\nexport const c = 3;\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "add b");
};

describe("implement scoring", () => {
  it("keeps hidden tests out of the workspace until scoring overlays them, after the package checks", async () => {
    const { exec, pnpm } = fakeExec({ hidden: true, own: true });

    const { hiddenAtLaunch } = await runArm(exec, addB);

    expect(hiddenAtLaunch).toBe(false);
    expect(pnpm.map((call) => [call.step, call.hiddenPresent])).toEqual([
      ["build", false],
      ["own", false],
      ["typecheck", false],
      ["hidden", true],
    ]);
  });

  it.each([
    [{ hidden: true, own: true }, true],
    [{ hidden: true, own: false }, false],
    [{ hidden: false, own: true }, false],
  ])("solves only when hidden and own suites both pass (%o)", async (outcomes, solved) => {
    const { scored } = await runArm(fakeExec(outcomes).exec, addB);

    expect(scored.outcome).toBeUndefined();
    expect(scored.result).toMatchObject({ score: { hiddenPass: outcomes.hidden, ownPass: outcomes.own, typecheck: true, solved, touched: ["packages/demo"] } });
  });

  it("reruns only the failing own-test files once, so a timing flake passes and a regression does not", async () => {
    const flaky = fakeExec({ hidden: true, own: "flaky" });
    const broken = fakeExec({ hidden: true, own: false });

    const passed = await runArm(flaky.exec, addB);
    const failed = await runArm(broken.exec, addB);

    expect(passed.scored.result).toMatchObject({ score: { ownPass: true, solved: true } });
    expect(failed.scored.result).toMatchObject({ score: { ownPass: false, solved: false } });
    expect(flaky.pnpm.map((call) => call.step)).toEqual(["build", "own", "own-rerun", "typecheck", "hidden"]);
  });

  it("measures the diff ratio against the accepted non-test lines and saves the patch", async () => {
    const { scored } = await runArm(fakeExec({ hidden: true, own: true }).exec, addB);

    expect(scored.result).toMatchObject({ score: { armNonTestLines: 2, acceptedNonTestLines: 4, diffLogRatio: -1 } });
    expect(readFileSync(join(runDir, "artifacts", "s1.patch"), "utf8")).toContain("+export const b = 2;");
  });

  it("scores an arm that changed nothing as unsolved but ok, with no ratio", async () => {
    const { exec, pnpm } = fakeExec({ hidden: true, own: true });

    const { scored } = await runArm(exec, undefined);

    expect(scored.outcome).toBeUndefined();
    expect(scored.result).toMatchObject({ score: { changed: false, solved: false, diffLogRatio: null } });
    expect(pnpm.map((call) => call.step)).toEqual(["hidden"]);
  });

  it("counts files the arm left uncommitted", async () => {
    const { scored } = await runArm(fakeExec({ hidden: true, own: true }).exec, (ws) => writeFileSync(join(ws, "packages", "demo", "src", "c.ts"), "export const c = 1;\n"));

    expect(scored.result).toMatchObject({ score: { changed: true, armNonTestLines: 1 } });
  });

  it("voids a contaminated job without running a scoring command", async () => {
    const transcript = join(root, "t.jsonl");
    const use = { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "gh pr view 12" } }] } };
    writeFileSync(transcript, `${JSON.stringify(use)}\n`);
    const { exec, pnpm } = fakeExec({ hidden: true, own: true });

    const { scored } = await runArm(exec, addB, transcript);

    expect(scored.outcome).toBe("contaminated");
    expect(pnpm).toEqual([]);
  });

  it("gives the job and the scorer the pinned pnpm, and scores under a user-shaped HOME", async () => {
    const pinned = (corepack: string) => existsSync(join(corepack, "v1", "pnpm", "9.15.0", "package.json"));
    const seen: { corepack: boolean; home?: string } = { corepack: false };
    const { exec } = fakeExec({ hidden: true, own: true });
    const watching: Exec = (file, args, options) => {
      const value = (name: string) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
      if (args.includes("vitest")) Object.assign(seen, { corepack: pinned(value("COREPACK_HOME") ?? ""), home: value("HOME") });
      return exec(file, args, options);
    };

    await runArm(watching, addB);

    expect(pinned(join(root, "job", "home", ".cache", "node", "corepack"))).toBe(true);
    expect(seen.corepack).toBe(true);
    expect(posix.dirname(seen.home ?? "")).toBe(posix.join(posix.sep, "home"));
  });

  it("reports no hidden failure count when vitest wrote no report", async () => {
    const { exec } = fakeExec({ hidden: true, own: true });
    const noReport: Exec = (file, args, options) => (args.includes("--outputFile") ? Promise.resolve({ status: 1, stdout: "", stderr: "corepack download refused" }) : exec(file, args, options));

    const { scored } = await runArm(noReport, addB);

    expect(scored.result).toMatchObject({ score: { hiddenPass: false, hiddenFailed: null, solved: false } });
  });

  it("cleanup removes the workspace and the scoring copy", async () => {
    const { prepared } = await runArm(fakeExec({ hidden: true, own: true }).exec, addB);

    expect([existsSync(prepared.cwd), existsSync(join(root, "job", "score"))]).toEqual([false, false]);
  });
});
