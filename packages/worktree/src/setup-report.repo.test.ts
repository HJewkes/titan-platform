import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedRepo } from "./git-fixture.js";
import { fixtureEnv } from "./test-env.js";
import {
  SETUP_FILE, SETUP_LOG, setupWorktree, runWorktreeSetup,
  type SetupResult, type SetupTarget,
} from "./setup.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function target(declaration?: string): SetupTarget {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-report-")));
  dirs.push(dir);
  seedRepo(dir, { "README.md": "seed", ...(declaration === undefined ? {} : { [SETUP_FILE]: declaration }) });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, env: fixtureEnv(), encoding: "utf8" }).trim();
  return { gitRoot: dir, worktree: dir, baseSha, fetched: true };
}
const declared = JSON.stringify({ setup: { command: ["synthetic-setup"], timeoutMs: 500 } });
const success: SetupResult = { exitCode: 0, timedOut: false, output: "" };

describe("setup reports with injected runners only", () => {
  it.each([
    ["ran", declared, success, 1],
    ["none", undefined, success, 0],
    ["failed", declared, { exitCode: 1, timedOut: false, output: "synthetic failure" }, 1],
  ] as const)("retains original recreation outcome %s", async (outcome, declaration, result, count) => {
    const t = target(declaration);
    const run = vi.fn(async () => result);
    const report = await setupWorktree(t, run);
    expect(report.outcome).toBe(outcome);
    expect(run).toHaveBeenCalledTimes(count);
    if (count) expect(run).toHaveBeenCalledWith(["synthetic-setup"], t.worktree, 500);
    if (outcome === "failed") expect(report.warnings[0]).toContain("exited with code 1");
    else expect(report.warnings).toEqual([]);
  });
  it.each([
    ["{}", "none", undefined],
    ["null", "none", undefined],
    ["", "skipped", "is empty"],
    ['{"setup":null}', "skipped", "setup must be an object"],
    ["not json", "skipped", "is not valid JSON"],
  ] as const)("does not execute declaration %s", async (declaration, outcome, diagnostic) => {
    const run = vi.fn(async () => success);
    const report = await setupWorktree(target(declaration), run);
    expect(report.outcome).toBe(outcome);
    expect(run).not.toHaveBeenCalled();
    if (diagnostic) expect(report.warnings[0]).toContain(diagnostic);
    else expect(report.warnings).toEqual([]);
  });
  it("refuses unfetched authority before parsing even malformed declarations", async () => {
    const run = vi.fn(async () => success);
    expect(await setupWorktree({ ...target("not json"), fetched: false }, run)).toEqual({
      outcome: "skipped",
      warnings: ["worktree setup skipped: .agent-chat/worktree.json is trusted only from origin's fetched default branch"],
    });
    expect(run).not.toHaveBeenCalled();
  });
  it.each([".npmrc", "pnpm-workspace.yaml"])("refuses a changed guarded %s", async file => {
    const t = target(declared);
    fs.writeFileSync(path.join(t.worktree, file), "synthetic changed");
    const run = vi.fn(async () => success);
    expect(await setupWorktree(t, run)).toEqual({
      outcome: "skipped",
      warnings: [`worktree setup skipped: the tree's ${file} differs from origin's default branch`],
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("preserves timeout-even-zero classification and keeps output in its log", async () => {
    const t = target(declared);
    const run = vi.fn(async () => ({ exitCode: 0, timedOut: true, output: "synthetic private output" }));
    const report = await setupWorktree(t, run);
    expect(report.outcome).toBe("failed");
    expect(report.warnings[0]).toContain("timed out after 500ms and was killed");
    expect(report.warnings.join("")).not.toContain("synthetic private output");
    const log = path.join(t.gitRoot, ".git", SETUP_LOG);
    expect(fs.readFileSync(log, "utf8")).toBe("synthetic private output");
    expect(fs.statSync(log).mode & 0o777).toBe(0o600);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("keeps failed outcome and diagnostic when its log cannot be written", async () => {
    const t = target(declared);
    fs.mkdirSync(path.join(t.gitRoot, ".git", SETUP_LOG));
    const run = vi.fn(async () => ({ exitCode: 2, timedOut: false, output: "synthetic private output" }));
    const report = await setupWorktree(t, run);
    expect(report).toEqual({
      outcome: "failed",
      warnings: ["worktree setup step `synthetic-setup` exited with code 2; the worktree may be missing its dependencies"],
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("records rejected runners as failed without returning their output", async () => {
    const t = target(declared);
    const run = vi.fn(async (): Promise<SetupResult> => { throw new Error("synthetic rejected"); });
    const report = await setupWorktree(t, run);
    expect(report.outcome).toBe("failed");
    expect(report.warnings[0]).toContain("exited with no exit code");
    expect(report.warnings.join("")).not.toContain("synthetic rejected");
    expect(fs.readFileSync(path.join(t.gitRoot, ".git", SETUP_LOG), "utf8")).toBe("Error: synthetic rejected");
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each([
    [undefined, success], [declared, success],
    ["", success], [declared, { exitCode: 3, timedOut: false, output: "synthetic" }],
  ] as const)("keeps the legacy warnings wrapper and one execution", async (declaration, result) => {
    const t = target(declaration);
    const reportRun = vi.fn(async () => result);
    const report = await setupWorktree(t, reportRun);
    const wrapperRun = vi.fn(async () => result);
    expect(await runWorktreeSetup(t, wrapperRun)).toEqual(report.warnings);
    expect(wrapperRun).toHaveBeenCalledTimes(reportRun.mock.calls.length);
    expect(wrapperRun.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
