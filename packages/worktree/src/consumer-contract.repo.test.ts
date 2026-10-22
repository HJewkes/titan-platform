import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorktreeAllocator } from "./allocator.js";
import { seedRepo, seedRepoWithOrigin } from "./git-fixture.js";
import { reattachWorktree } from "./reattach.js";
import { fixtureEnv } from "./test-env.js";

vi.setConfig({ testTimeout: 20_000 });
const roots: string[] = [];
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: fixtureEnv(), stdio: "pipe" }).trim();
function repo(remote = false): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-consumer-")));
  roots.push(root);
  const dir = path.join(root, "repo");
  fs.mkdirSync(dir);
  if (remote) {
    const origin = path.join(root, "origin"); fs.mkdirSync(origin);
    seedRepoWithOrigin(dir, origin);
  } else seedRepo(dir);
  return dir;
}
const request = (baseCwd: string, agentName: string) => ({ baseCwd, agentName });
const group = (name: string): string => name.startsWith("reader-") ? "readers" : "writers";
const grouped = {
  allocationGroup: group,
  budget: (name: string) => group(name) === "readers" ? 2 : 1,
};
function tree(root: string, name: string): string {
  const dir = path.join(root, ".worktrees", name);
  git(root, "worktree", "add", "-b", `agent-chat/${name}`, dir, "main");
  return dir;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("optional consumer allocation contracts", () => {
  it("counts only the requested group and resolves its name-aware budget", async () => {
    const root = repo(); tree(root, "reader-a"); tree(root, "reader-b");
    const allocator = createWorktreeAllocator(grouped);
    expect(await allocator.check(request(root, "writer-a"))).toEqual({ refusals: [], warnings: [] });
    const writer = await allocator.allocate(request(root, "writer-a"));
    expect(fs.existsSync(writer.cwd)).toBe(true);
    expect((await allocator.check(request(root, "reader-c"))).refusals).toEqual(["Worktree budget exhausted: 2/2 allocated"]);
    expect((await allocator.check(request(root, "writer-b"))).refusals).toEqual(["Worktree budget exhausted: 1/1 allocated"]);
  });
  it("lets the host preserve its error class and wording without parsing strings", async () => {
    const root = repo(); tree(root, "writer-a");
    class HostBudgetError extends Error {}
    const allocator = createWorktreeAllocator({ ...grouped,
      budgetError: (allocated: number, budget: number, name: string) => new HostBudgetError(`${name}: ${allocated}/${budget}`) });
    expect((await allocator.check(request(root, "writer-b"))).refusals).toEqual(["writer-b: 1/1"]);
    await expect(allocator.allocate(request(root, "writer-b"))).rejects.toBeInstanceOf(HostBudgetError);
  });
  it("applies the same grouping and current budget when reattaching", async () => {
    const root = repo(); tree(root, "reader-a"); tree(root, "reader-b");
    const worktree = path.join(root, ".worktrees", "writer-a");
    git(root, "branch", "agent-chat/writer-a");
    const allocation = await reattachWorktree({ gitRoot: root, worktree, branch: "agent-chat/writer-a" }, grouped);
    expect(allocation.cwd).toBe(worktree);
    expect(fs.existsSync(worktree)).toBe(true);
  });
  it("retains a parked branch while refusing a live tree even with force", async () => {
    const root = repo(); const allocator = createWorktreeAllocator();
    const req = request(root, "keep"); const allocation = await allocator.allocate(req);
    expect((await allocator.release({}, allocation, { keepBranch: true, force: true })).released).toBe(false);
    expect(fs.existsSync(allocation.cwd)).toBe(true);
    git(root, "worktree", "remove", allocation.cwd);
    expect(await allocator.release({}, allocation, { keepBranch: true })).toEqual({ released: true });
    expect(git(root, "rev-parse", (allocation.ref.branch ?? "missing"))).toBe(git(root, "rev-parse", "HEAD"));
  });
  it("keeps the assigned exemption before branch-keeping checks", async () => {
    const root = repo(); const assigned = tree(root, "assigned"); const allocator = createWorktreeAllocator();
    const allocation = await allocator.allocate({ ...request(root, "other"), assignedWorktree: assigned });
    expect(await allocator.release({}, allocation, { keepBranch: true, force: true })).toEqual({ released: true });
    expect(fs.existsSync(assigned)).toBe(true);
  });
});

function stack(root: string): string {
  git(root, "switch", "-c", "stack"); fs.writeFileSync(path.join(root, "parent"), "parent slice");
  git(root, "add", "."); git(root, "commit", "-m", "parent slice");
  const sha = git(root, "rev-parse", "HEAD"); git(root, "push", "origin", "stack"); git(root, "switch", "main");
  return sha;
}
describe("requested checkout base with unchanged setup authority", () => {
  it("fetches the requested origin branch and refuses invalid or missing branches without fallback", async () => {
    const root = repo(true); const sha = stack(root); const allocator = createWorktreeAllocator();
    const allocation = await allocator.allocate({ ...request(root, "child"), baseRef: "origin/stack" });
    expect(allocation.ref.base).toBe(sha);
    expect(allocation.ref.base_ref).toBe("origin/stack");
    expect(fs.readFileSync(path.join(allocation.cwd, "parent"), "utf8")).toBe("parent slice");
    for (const baseRef of ["main", "origin/-bad", "origin/absent"]) {
      await expect(allocator.allocate({ ...request(root, "bad"), baseRef })).rejects.toThrow();
      expect(fs.existsSync(path.join(root, ".worktrees", "bad"))).toBe(false);
    }
  });
  it("runs only the fetched default branch setup declaration on a requested checkout", async () => {
    const root = repo(true); fs.mkdirSync(path.join(root, ".agent-chat"));
    const file = path.join(root, ".agent-chat", "worktree.json");
    fs.writeFileSync(file, JSON.stringify({ setup: { command: ["trusted-default"] } }));
    git(root, "add", "."); git(root, "commit", "-m", "trusted setup"); git(root, "push", "origin", "main");
    stack(root); git(root, "switch", "stack");
    fs.writeFileSync(file, JSON.stringify({ setup: { command: ["untrusted-stack"] } }));
    git(root, "add", "."); git(root, "commit", "-m", "stack declaration");
    git(root, "push", "origin", "stack"); const sha = git(root, "rev-parse", "HEAD"); git(root, "switch", "main");
    const runSetup = vi.fn(async () => ({ exitCode: 0, timedOut: false, output: "" }));
    const allocator = createWorktreeAllocator({ runSetup });
    const allocation = await allocator.allocate({ ...request(root, "child"), baseRef: "origin/stack" });
    expect(allocation.ref.base).toBe(sha);
    expect(runSetup).toHaveBeenCalledExactlyOnceWith(["trusted-default"], allocation.cwd, 300_000);
  });
  it("supports an explicit caller-owned setup adapter without running setup twice", async () => {
    const root = repo(true); fs.mkdirSync(path.join(root, ".agent-chat"));
    fs.writeFileSync(path.join(root, ".agent-chat", "worktree.json"), JSON.stringify({ setup: { command: ["default"] } }));
    git(root, "add", "."); git(root, "commit", "-m", "setup"); git(root, "push", "origin", "main");
    const runSetup = vi.fn(async () => ({ exitCode: 0, timedOut: false, output: "" }));
    const allocation = await createWorktreeAllocator({ skipSetup: true, runSetup }).allocate(request(root, "child"));
    expect(fs.existsSync(allocation.cwd)).toBe(true);
    expect(runSetup).not.toHaveBeenCalled();
    git(root, "worktree", "remove", allocation.cwd);
    await reattachWorktree({ gitRoot: root, worktree: allocation.cwd, branch: allocation.ref.branch ?? "missing" }, { skipSetup: true, runSetup });
    expect(runSetup).not.toHaveBeenCalled();
  });
});
