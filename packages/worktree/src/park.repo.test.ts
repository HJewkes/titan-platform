import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorktreeAllocator } from "./allocator.js";
import { WorktreeBudgetExhaustedError } from "./errors.js";
import { parkWorktree } from "./park.js";
import { recreateWorktree, type WorktreeRecord } from "./reattach.js";
import { seedRepo, seedRepoWithOrigin } from "./git-fixture.js";
import { fixtureEnv } from "./test-env.js";

// Real repositories, clones and process groups: slower than a unit test, and slower still under a parallel run.
vi.setConfig({ testTimeout: 20_000 });

/**
 * Park removes a finished agent's clean, pushed worktree and keeps its branch,
 * so `recreateWorktree` puts the tree back at the same path.
 */

const tmpDirs: string[] = [];

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
};

const git = (args: string[], cwd: string): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", env: fixtureEnv() }).trim();

function makeRepo(): string {
  const dir = tmp("park-repo-");
  seedRepo(dir);
  return dir;
}

function repoWithOrigin(): string {
  const repo = tmp("park-repo-");
  seedRepoWithOrigin(repo, tmp("park-origin-"));
  return repo;
}

const commitIn = (dir: string, file: string): string => {
  fs.writeFileSync(path.join(dir, file), "work\n");
  git(["add", file], dir);
  git(["commit", "-m", `add ${file}`], dir);
  return git(["rev-parse", "HEAD"], dir);
};

const branchHead = (repo: string, branch: string): string => git(["rev-parse", "--verify", branch], repo);

const treesUnder = (repo: string): number =>
  git(["worktree", "list", "--porcelain"], repo)
    .split("\n")
    .filter((line) => line.startsWith(`worktree ${path.join(repo, ".worktrees")}${path.sep}`)).length;

/** A finished agent's tree, as the caller recorded its allocation. */
async function treeIn(repo: string, name = "worker-a", budget = 3): Promise<WorktreeRecord> {
  const { cwd, ref } = await createWorktreeAllocator({ budget }).allocate({ agentName: name, baseCwd: repo });
  return { gitRoot: repo, worktree: cwd, branch: ref.branch as string };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("parking a finished agent", () => {
  it("removes a pushed tree, keeps the branch, and resume brings it back at the same path on the pushed head", async () => {
    const repo = repoWithOrigin();
    const tree = await treeIn(repo);
    const pushed = commitIn(tree.worktree, "feature.ts");
    git(["push", "-q", "origin", "agent-chat/worker-a"], tree.worktree);

    const parked = await parkWorktree(tree);

    expect(parked).toEqual({ ok: true, head: pushed });
    expect(fs.existsSync(tree.worktree)).toBe(false);
    expect(branchHead(repo, "agent-chat/worker-a")).toBe(pushed);

    const resumed = await recreateWorktree(tree);

    expect(resumed.cwd).toBe(tree.worktree);
    expect(git(["rev-parse", "HEAD"], tree.worktree)).toBe(pushed);
  });

  it("keeps the local branch in a repository with no remote", async () => {
    const repo = makeRepo();
    const tree = await treeIn(repo);
    const committed = commitIn(tree.worktree, "feature.ts");

    const parked = await parkWorktree(tree);

    expect(parked.ok).toBe(true);
    expect(fs.existsSync(tree.worktree)).toBe(false);
    expect(branchHead(repo, "agent-chat/worker-a")).toBe(committed);
  });

  it("drops the repository worktree count by one, freeing a budget slot", async () => {
    const repo = makeRepo();
    const tree = await treeIn(repo, "worker-a", 1);
    const other = createWorktreeAllocator({ budget: 1 });
    await expect(other.allocate({ agentName: "other", baseCwd: repo })).rejects.toBeInstanceOf(
      WorktreeBudgetExhaustedError
    );
    const before = treesUnder(repo);

    expect((await parkWorktree(tree)).ok).toBe(true);

    expect(treesUnder(repo)).toBe(before - 1);
    await expect(other.allocate({ agentName: "other", baseCwd: repo })).resolves.toMatchObject({
      ref: { branch: "agent-chat/other" },
    });
  });
});

describe("refusing to park", () => {
  it("refuses a tree with uncommitted changes and leaves it", async () => {
    const tree = await treeIn(makeRepo());
    fs.writeFileSync(path.join(tree.worktree, "scratch.txt"), "draft\n");

    const parked = await parkWorktree(tree);

    expect(parked).toMatchObject({ ok: false, reason: expect.stringMatching(/uncommitted or untracked changes/) });
    expect(fs.existsSync(tree.worktree)).toBe(true);
  });

  it("refuses a branch that was never pushed to origin", async () => {
    const tree = await treeIn(repoWithOrigin());
    commitIn(tree.worktree, "feature.ts");

    const parked = await parkWorktree(tree);

    expect(parked).toMatchObject({ ok: false, reason: expect.stringMatching(/not on origin; push it first/) });
    expect(fs.existsSync(tree.worktree)).toBe(true);
  });

  it("refuses commits made after the last push", async () => {
    const tree = await treeIn(repoWithOrigin());
    commitIn(tree.worktree, "feature.ts");
    git(["push", "-q", "origin", "agent-chat/worker-a"], tree.worktree);
    commitIn(tree.worktree, "more.ts");

    const parked = await parkWorktree(tree);

    expect(parked).toMatchObject({ ok: false, reason: expect.stringMatching(/1 commit\(s\).*not on origin/) });
    expect(fs.existsSync(tree.worktree)).toBe(true);
  });

  it("refuses when a claimant arrives between the checks and the removal", async () => {
    const tree = await treeIn(makeRepo());

    const parked = await parkWorktree(tree, () => "a resume started meanwhile");

    expect(parked).toEqual({ ok: false, reason: "a resume started meanwhile" });
    expect(fs.existsSync(tree.worktree)).toBe(true);
  });
});

describe("refusing to park what the removal would lose", () => {
  it("refuses a commit on a detached HEAD in a repository with no remote", async () => {
    const tree = await treeIn(makeRepo());
    git(["checkout", "-q", "--detach"], tree.worktree);
    const orphan = commitIn(tree.worktree, "feature.ts");

    const parked = await parkWorktree(tree);

    expect(parked).toMatchObject({ ok: false, reason: expect.stringMatching(/HEAD in .* is detached/) });
    expect(git(["rev-parse", "HEAD"], tree.worktree)).toBe(orphan);
  });

  it("refuses a tree checked out on a different branch", async () => {
    const tree = await treeIn(makeRepo());
    git(["checkout", "-q", "-b", "side"], tree.worktree);

    const parked = await parkWorktree(tree);

    expect(parked).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/is on side, not on agent-chat\/worker-a/),
    });
    expect(fs.existsSync(tree.worktree)).toBe(true);
  });

  it("refuses an untracked file that status.showUntrackedFiles=no hides", async () => {
    const tree = await treeIn(makeRepo());
    git(["config", "status.showUntrackedFiles", "no"], tree.worktree);
    fs.writeFileSync(path.join(tree.worktree, "notes.txt"), "draft\n");

    const parked = await parkWorktree(tree);

    expect(parked).toMatchObject({ ok: false, reason: expect.stringMatching(/untracked changes/) });
    expect(fs.existsSync(path.join(tree.worktree, "notes.txt"))).toBe(true);
  });

  it("refuses an ignored file outside the regenerable set, naming the rule", async () => {
    const tree = await treeIn(makeRepo());
    fs.writeFileSync(path.join(tree.worktree, ".gitignore"), ".env\nnode_modules/\n");
    git(["add", ".gitignore"], tree.worktree);
    git(["commit", "-q", "-m", "ignore"], tree.worktree);
    fs.writeFileSync(path.join(tree.worktree, ".env"), "TOKEN=synthetic\n");

    const parked = await parkWorktree(tree);

    expect(parked).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/ignored files .* \(\.env\); only ignored node_modules, dist/),
    });
    expect(fs.existsSync(path.join(tree.worktree, ".env"))).toBe(true);
  });

  it("parks a tree whose only ignored files are regenerable", async () => {
    const tree = await treeIn(makeRepo());
    fs.writeFileSync(path.join(tree.worktree, ".gitignore"), "node_modules/\ndist/\n");
    git(["add", ".gitignore"], tree.worktree);
    git(["commit", "-q", "-m", "ignore"], tree.worktree);
    fs.mkdirSync(path.join(tree.worktree, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(tree.worktree, "node_modules", "dep", "index.js"), "\n");
    fs.mkdirSync(path.join(tree.worktree, "dist"));
    fs.writeFileSync(path.join(tree.worktree, "dist", "cli.js"), "\n");

    expect((await parkWorktree(tree)).ok).toBe(true);
    expect(fs.existsSync(tree.worktree)).toBe(false);
  });
});
