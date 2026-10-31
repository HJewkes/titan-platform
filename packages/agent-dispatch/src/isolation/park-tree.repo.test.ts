import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commitIn, git, makeRepo, removeTempDirs, tempDir, withRemote } from "./fixtures/git-repo.js";
import type { ParkTarget } from "./park-rules.js";
import { lsofCwds, parkWorktree } from "./park-tree.js";
import { createWorktreeStrategy } from "./worktree.js";

/**
 * CC-282: park removes a finished agent's clean, pushed worktree and keeps its branch. The refusals
 * that need a broker stay with the host; these are the removal, its process check and its backing.
 */

vi.setConfig({ testTimeout: 30_000 });
afterEach(removeTempDirs);

const strategy = createWorktreeStrategy();
const branch = "agent-chat/worker-a";

async function treeIn(repo: string): Promise<ParkTarget> {
  const { cwd } = await strategy.allocate({ agentId: "a1", agentName: "worker-a", baseCwd: repo });
  return { gitRoot: repo, worktree: cwd, branch, assigned: false };
}

function repoWithOrigin(): { repo: string; origin: string } {
  const repo = makeRepo();
  return { repo, origin: withRemote(repo) };
}

const noRecheck = (): undefined => undefined;

function ignoreInTree(tree: string, patterns: string): void {
  fs.writeFileSync(path.join(tree, ".gitignore"), patterns);
  git(["add", ".gitignore"], tree);
  git(["commit", "-q", "-m", "ignore"], tree);
}

describe("parking a tree whose work is safe", () => {
  it("removes a pushed tree and keeps the branch", async () => {
    const { repo } = repoWithOrigin();
    const target = await treeIn(repo);
    const head = commitIn(target.worktree, "feature.ts");
    git(["push", "-q", "origin", branch], target.worktree);

    const parked = await parkWorktree(target, noRecheck);

    expect(parked).toMatchObject({ ok: true, head });
    expect(fs.existsSync(target.worktree)).toBe(false);
    expect(git(["rev-parse", "--verify", branch], repo)).toBe(head);
  });

  it("names the origin branch that holds HEAD", async () => {
    const { repo } = repoWithOrigin();
    const target = await treeIn(repo);
    const head = commitIn(target.worktree, "feature.ts");
    git(["push", "-q", "origin", "HEAD:agent-chat/pr-x"], target.worktree);

    const parked = await parkWorktree(target, noRecheck);

    expect(parked).toEqual({ ok: true, head, branch, containedIn: "agent-chat/pr-x" });
  });

  it("refuses when the recheck finds a spawn that started meanwhile", async () => {
    const { repo } = repoWithOrigin();
    const target = await treeIn(repo);

    const parked = await parkWorktree(target, () => "successor spawned");

    expect(parked).toEqual({ ok: false, reason: "successor spawned" });
    expect(fs.existsSync(target.worktree)).toBe(true);
  });
});

describe("parking under dispatch's ignored-file policy", () => {
  it("parks a tree whose only ignored files are tsbuildinfo, which the package alone would keep", async () => {
    const { repo } = repoWithOrigin();
    const target = await treeIn(repo);
    ignoreInTree(target.worktree, "*.tsbuildinfo\n");
    git(["push", "-q", "origin", branch], target.worktree);
    fs.writeFileSync(path.join(target.worktree, "tsconfig.tsbuildinfo"), "{}\n");

    expect((await parkWorktree(target, noRecheck)).ok).toBe(true);
    expect(fs.existsSync(target.worktree)).toBe(false);
  });

  it("refuses an ignored file outside the regenerable set, naming the rule", async () => {
    const { repo } = repoWithOrigin();
    const target = await treeIn(repo);
    ignoreInTree(target.worktree, ".env\nnode_modules/\n");
    git(["push", "-q", "origin", branch], target.worktree);
    fs.writeFileSync(path.join(target.worktree, ".env"), "TOKEN=synthetic\n");

    const parked = await parkWorktree(target, noRecheck);

    expect(parked).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/ignored files .* \(\.env\); park removes only ignored node_modules, dist/),
    });
    expect(fs.existsSync(path.join(target.worktree, ".env"))).toBe(true);
  });
});

describe("parking an agent a process may outlive", () => {
  async function pushedTree(): Promise<ParkTarget> {
    const { repo } = repoWithOrigin();
    const target = await treeIn(repo);
    git(["push", "-q", "origin", branch], target.worktree);
    return target;
  }

  it("refuses while a process has its cwd inside the tree, naming the pid", async () => {
    const target = await pushedTree();
    const lister = async () => [{ pid: 4711, cwd: path.join(target.worktree, "sub") }];

    const parked = await parkWorktree(target, noRecheck, lister);

    expect(parked).toMatchObject({ ok: false, reason: expect.stringMatching(/process 4711 .*not parked/) });
    expect(fs.existsSync(target.worktree)).toBe(true);
  });

  it("refuses when the process list cannot be read", async () => {
    const target = await pushedTree();
    const lister = () => Promise.reject(new Error("lsof: not found"));

    const parked = await parkWorktree(target, noRecheck, lister);

    expect(parked).toMatchObject({ ok: false, reason: expect.stringMatching(/could not check .*lsof: not found/) });
    expect(fs.existsSync(target.worktree)).toBe(true);
  });

  it("parks past a process running elsewhere", async () => {
    const target = await pushedTree();
    const lister = async () => [{ pid: 4711, cwd: tempDir("elsewhere-") }];

    expect((await parkWorktree(target, noRecheck, lister)).ok).toBe(true);
  });

  it("refuses while a real child process runs in the tree", async () => {
    const target = await pushedTree();
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], {
      cwd: target.worktree,
      stdio: "ignore",
    });
    try {
      await new Promise((resolve) => child.once("spawn", resolve));

      const parked = await parkWorktree(target, noRecheck, lsofCwds);

      expect(parked).toMatchObject({ ok: false, reason: expect.stringContaining(`process ${child.pid}`) });
    } finally {
      child.kill("SIGKILL");
    }
    expect(fs.existsSync(target.worktree)).toBe(true);
  });
});

describe("parking a squash-merged tree whose head branch origin deleted (CC-1064)", () => {
  /** A tree whose HEAD was pushed as its PR branch, which origin then deleted and a fetch pruned. */
  async function mergedAndDeleted(): Promise<{ repo: string; target: ParkTarget; head: string }> {
    const { repo, origin } = repoWithOrigin();
    const target = await treeIn(repo);
    const head = commitIn(target.worktree, "feature.ts");
    git(["push", "-q", "origin", `HEAD:${branch}`], target.worktree);
    git(["branch", "-q", "-D", branch], origin);
    git(["fetch", "-q", "--prune", "origin"], repo);
    return { repo, target, head };
  }

  it("parks when a merged PR on the branch has HEAD as its head commit, keeping the branch", async () => {
    const { repo, target, head } = await mergedAndDeleted();
    const asked: string[] = [];
    const reader = async (_root: string, b: string) => (asked.push(b), [{ number: 7, headSha: head }]);

    const parked = await parkWorktree(target, noRecheck, undefined, reader);

    expect(parked).toEqual({ ok: true, head, branch, mergedPr: 7 });
    expect(asked).toEqual([branch]);
    expect(fs.existsSync(target.worktree)).toBe(false);
    expect(git(["rev-parse", "--verify", branch], repo)).toBe(head);
  });

  it("refuses when no merged PR is on the branch", async () => {
    const { target } = await mergedAndDeleted();

    const parked = await parkWorktree(target, noRecheck, undefined, async () => []);

    expect(parked).toMatchObject({ ok: false, reason: expect.stringMatching(/not on origin/) });
    expect(fs.existsSync(target.worktree)).toBe(true);
  });

  it("refuses when gh cannot answer", async () => {
    const { target } = await mergedAndDeleted();
    const reader = () => Promise.reject(new Error("gh: not logged in"));

    const parked = await parkWorktree(target, noRecheck, undefined, reader);

    expect(parked).toMatchObject({ ok: false, reason: expect.stringMatching(/not on origin/) });
    expect(fs.existsSync(target.worktree)).toBe(true);
  });

  it("refuses a commit made after the merged PR head", async () => {
    const { target, head } = await mergedAndDeleted();
    commitIn(target.worktree, "more.ts");

    const parked = await parkWorktree(target, noRecheck, undefined, async () => [{ number: 7, headSha: head }]);

    expect(parked).toMatchObject({ ok: false, reason: expect.stringMatching(/not on origin/) });
    expect(fs.existsSync(target.worktree)).toBe(true);
  });

  it("refuses a PR head commit whose object is not local", async () => {
    const { target } = await mergedAndDeleted();
    const reader = async () => [{ number: 7, headSha: "f".repeat(40) }];

    const parked = await parkWorktree(target, noRecheck, undefined, reader);

    expect(parked).toMatchObject({ ok: false, reason: expect.stringMatching(/not on origin/) });
    expect(fs.existsSync(target.worktree)).toBe(true);
  });

  it("drops a malformed sha and still counts the PR beside it", async () => {
    const { target, head } = await mergedAndDeleted();
    const reader = async () => [
      { number: 6, headSha: "--output=/tmp/x" },
      { number: 7, headSha: head },
    ];

    const parked = await parkWorktree(target, noRecheck, undefined, reader);

    expect(parked).toMatchObject({ ok: true, mergedPr: 7 });
  });

  it("parks a tree on a local side branch whose merged PR holds HEAD, keeping that branch", async () => {
    const { repo } = repoWithOrigin();
    const target = await treeIn(repo);
    git(["checkout", "-q", "-b", "side"], target.worktree);
    const head = commitIn(target.worktree, "feature.ts");
    const reader = async (_root: string, b: string) => (b === "side" ? [{ number: 9, headSha: head }] : []);

    const parked = await parkWorktree(target, noRecheck, undefined, reader);

    expect(parked).toEqual({ ok: true, head, branch: "side", mergedPr: 9 });
    expect(git(["rev-parse", "--verify", "side"], repo)).toBe(head);
  });

  it("refuses as before when no reader is passed", async () => {
    const { target } = await mergedAndDeleted();

    const parked = await parkWorktree(target, noRecheck);

    expect(parked).toEqual({ ok: false, reason: `${branch} is not on origin; push it first` });
    expect(fs.existsSync(target.worktree)).toBe(true);
  });
});
