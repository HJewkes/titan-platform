import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorktreeAllocator } from "./allocator.js";
import { reattachWorktree } from "./reattach.js";
import { seedRepo, seedRepoWithOrigin } from "./git-fixture.js";
import { SETUP_FILE, type SetupRunner } from "./setup.js";
import { fixtureEnv } from "./test-env.js";

const dirs: string[] = [];
afterEach(() => {
  for (const p of dirs.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});
function temp(): string {
  const p = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-target-")));
  dirs.push(p);
  return p;
}
const git = (args: string[], cwd: string): string =>
  execFileSync("git", args, { cwd, env: fixtureEnv(), stdio: "pipe", encoding: "utf8" }).trim();
function repo(declares = true, fetched = true): string {
  const p = temp();
  const files = { "README.md": "seed", ...(declares ? {
    [SETUP_FILE]: JSON.stringify({ setup: { command: ["synthetic-setup"] } }),
  } : {}) };
  if (fetched) seedRepoWithOrigin(p, temp(), files);
  else seedRepo(p, files);
  return p;
}
const request = (root: string) => ({ baseCwd: root, agentName: "synthetic" });
const runner = () => vi.fn<SetupRunner>(async () => ({ exitCode: 0, timedOut: false, output: "" }));

describe("opt-in actual setup target metadata", () => {
  it.each([undefined, false])("keeps the default key set with includeSetupTarget=%s", async flag => {
    const root = repo();
    const run = runner();
    const allocation = await createWorktreeAllocator({ includeSetupTarget: flag, runSetup: run }).allocate(request(root));
    expect(Object.hasOwn(allocation, "setupTarget")).toBe(false);
    expect(Object.keys(allocation).sort()).toEqual(["cwd", "note", "ref"]);
    expect(run).toHaveBeenCalledExactlyOnceWith(["synthetic-setup"], allocation.cwd, 300_000);
  });
  it("returns its actual fetched base without suppressing or repeating setup", async () => {
    const root = repo();
    const run = runner();
    const allocation = await createWorktreeAllocator({ includeSetupTarget: true, runSetup: run }).allocate(request(root));
    expect(Object.hasOwn(allocation, "setupTarget")).toBe(true);
    expect(allocation.setupTarget).toEqual({
      gitRoot: root, worktree: allocation.cwd,
      baseSha: git(["rev-parse", "origin/main"], root), fetched: true,
    });
    expect(run).toHaveBeenCalledExactlyOnceWith(["synthetic-setup"], allocation.cwd, 300_000);
  });
  it("returns an actually selected base even when no step is declared", async () => {
    const root = repo(false);
    const run = runner();
    const allocation = await createWorktreeAllocator({ includeSetupTarget: true, runSetup: run }).allocate(request(root));
    expect(Object.hasOwn(allocation, "setupTarget")).toBe(true);
    expect(allocation.setupTarget?.baseSha).toBe(git(["rev-parse", "origin/main"], root));
    expect(allocation.setupTarget?.fetched).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(allocation.warnings).toBeUndefined();
  });
  it("does not turn a diagnostic local HEAD fallback into fetched authority", async () => {
    const root = repo(true, false);
    const run = runner();
    const allocation = await createWorktreeAllocator({ includeSetupTarget: true, runSetup: run }).allocate(request(root));
    expect(allocation.setupTarget).toEqual({
      gitRoot: root, worktree: allocation.cwd,
      baseSha: git(["rev-parse", "HEAD"], root), fetched: false,
    });
    expect(run).not.toHaveBeenCalled();
    expect(allocation.warnings).toEqual([
      expect.stringContaining("the repository has no origin remote"),
      "worktree setup skipped: .agent-chat/worktree.json is trusted only from origin's fetched default branch",
    ]);
  });
  it("omits a target on an existing assigned tree and does not run setup", async () => {
    const root = repo();
    const run = runner();
    const allocation = await createWorktreeAllocator({ includeSetupTarget: true, runSetup: run }).allocate({
      ...request(root), assignedWorktree: root,
    });
    expect(Object.hasOwn(allocation, "setupTarget")).toBe(false);
    expect(Object.keys(allocation).sort()).toEqual(["cwd", "note", "ref"]);
    expect(allocation.ref.assigned).toBe("true");
    expect(run).not.toHaveBeenCalled();
  });
  it.each([undefined, false, true])("preserves recreation behavior and opt-in target with flag %s", async flag => {
    const root = repo();
    const run = runner();
    const first = await createWorktreeAllocator({ runSetup: run }).allocate(request(root));
    git(["worktree", "remove", "--force", first.cwd], root);
    run.mockClear();
    const allocation = await reattachWorktree({
      gitRoot: root, worktree: first.cwd, branch: first.ref.branch ?? "",
    }, { includeSetupTarget: flag, runSetup: run });
    expect(Object.hasOwn(allocation, "setupTarget")).toBe(flag === true);
    if (flag === true) expect(allocation.setupTarget).toEqual({
      gitRoot: root, worktree: allocation.cwd,
      baseSha: git(["rev-parse", "origin/main"], root), fetched: true,
    });
    expect(run).toHaveBeenCalledExactlyOnceWith(["synthetic-setup"], first.cwd, 300_000);
  });
});
