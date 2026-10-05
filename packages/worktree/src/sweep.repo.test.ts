import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorktreeAllocator } from "./allocator.js";
import { RECLAIM_GRACE_MS } from "./options.js";
import {
  reclaimWorktree,
  sweepWorktrees,
  type GitLister,
  type HeldWorktree,
  type SweepOptions,
  type SweepOwner,
} from "./sweep.js";
import { fixtureEnv } from "./test-env.js";

// Real repositories, clones and process groups: slower than a unit test, and slower still under a parallel run.
vi.setConfig({ testTimeout: 20_000 });

/**
 * Release frees a worktree when a person decides they are done. The leak is the
 * case where nobody decides: an agent exits, is never released, and holds its
 * worktree and branch indefinitely. These prove the sweep finds that, and that
 * every guard which stops it destroying work still stands.
 */

const tmpDirs: string[] = [];
/** What the caller believes it still holds, as its runtime records would say. */
let held: HeldWorktree[] = [];
const worktreeStrategy = createWorktreeAllocator();

const git = (args: string[], cwd: string): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", env: fixtureEnv() }).trim();

const lister: GitLister = async (gitRoot) => git(["worktree", "list", "--porcelain"], gitRoot);

function makeRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sweep-")));
  tmpDirs.push(dir);
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "seed\n");
  git(["add", "."], dir);
  git(["commit", "-m", "seed"], dir);
  return dir;
}

/** An agent that allocated a worktree and left its allocation record behind. */
async function abandonedWorktree(repo: string, name = "scout"): Promise<string> {
  const { cwd, ref } = await worktreeStrategy.allocate({ agentName: name, baseCwd: repo });
  held.push({ gitRoot: repo, branch: ref.branch as string, ...(ref.base ? { base: ref.base } : {}) });
  return cwd;
}

const identity = (over: Partial<SweepOwner> = {}): SweepOwner => ({
  agentId: "a1",
  name: "scout",
  state: "exited",
  lastEventAt: 0,
  ...over,
});

/** The caller's roster joined on the branch, as a dispatcher would. */
const sweep = (roster: readonly SweepOwner[], options: Omit<SweepOptions, "held" | "ownerOf">) =>
  sweepWorktrees({ ...options, held, ownerOf: (found) => roster.find((a) => found.branch === `agent-chat/${a.name}`) });

afterEach(() => {
  held = [];
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("finding what nobody is using", () => {
  it("reports a worktree whose agent exited and was never retired", async () => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);

    const swept = await sweep([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 });

    expect(swept).toHaveLength(1);
    expect(swept[0]?.status).toBe("reclaimable");
    expect(swept[0]?.worktree).toBe(worktree);
    expect(swept[0]?.agent?.name).toBe("scout");
  });

  it("leaves a worktree alone while its agent is still running", async () => {
    const repo = makeRepo();
    await abandonedWorktree(repo);

    const swept = await sweep([identity({ state: "live" })], { list: lister });

    expect(swept[0]?.status).toBe("held");
    expect(swept[0]?.detail).toMatch(/scout is live/);
  });

  it("holds off inside the grace window that protects work nobody has noticed", async () => {
    const repo = makeRepo();
    await abandonedWorktree(repo);

    const swept = await sweep([identity({ lastEventAt: 1000 })], {
      list: lister,
      now: () => 1000 + RECLAIM_GRACE_MS / 2,
    });

    expect(swept[0]?.status).toBe("in-grace");
    expect(swept[0]?.detail).toMatch(/reclaimable after 120s/);
  });

  it("times the grace window from the exit, not from a later row such as a refused retire", async () => {
    const repo = makeRepo();
    await abandonedWorktree(repo);
    const exitedAt = 1000;
    const refusedRetireAt = exitedAt + 85_000;

    const swept = await sweep([identity({ exitedAt, lastEventAt: refusedRetireAt })], {
      list: lister,
      now: () => exitedAt + RECLAIM_GRACE_MS + 1,
    });

    expect(swept[0]?.status).toBe("reclaimable");
  });

  it("times the grace window from the last event for a detached agent that never exited", async () => {
    const repo = makeRepo();
    await abandonedWorktree(repo);
    const lastEventAt = 1_000_000;

    const swept = await sweep([identity({ state: "detached", lastEventAt })], {
      list: lister,
      now: () => lastEventAt + RECLAIM_GRACE_MS / 2,
    });

    expect(swept[0]?.status).toBe("in-grace");
  });

  it("refuses one holding commits that exist nowhere else", async () => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);
    fs.writeFileSync(path.join(worktree, "feature.ts"), "work\n");
    git(["add", "feature.ts"], worktree);
    git(["commit", "-m", "work"], worktree);

    const swept = await sweep([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 });

    expect(swept[0]?.status).toBe("holds-work");
    expect(swept[0]?.detail).toMatch(/exist nowhere else/);
  });

  it("refuses one with uncommitted changes", async () => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);
    fs.writeFileSync(path.join(worktree, "scratch.txt"), "unsaved\n");

    const swept = await sweep([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 });

    expect(swept[0]?.status).toBe("holds-work");
    expect(swept[0]?.detail).toMatch(/uncommitted or untracked changes/);
  });

  /**
   * A worktree no allocation record points at is found only when the caller
   * names its repository.
   */
  it("finds one no allocation record points at, when the repo is named", async () => {
    const repo = makeRepo();
    await worktreeStrategy.allocate({ agentName: "ghost", baseCwd: repo });

    const swept = await sweep([], { list: lister, roots: [repo], now: () => RECLAIM_GRACE_MS + 1 });

    expect(swept[0]?.branch).toBe("agent-chat/ghost");
    expect(swept[0]?.agent).toBeUndefined();
    expect(swept[0]?.detail).toMatch(/no agent in the log claims this branch/);
  });

  /**
   * Other tools' agent worktrees sit on ordinary branch names and are
   * usually locked. They are a different tool's leak; reporting a reclaim here
   * that we would then refuse to perform would be worse than ignoring them.
   */
  it("ignores worktrees another tool owns, including locked ones", async () => {
    const repo = makeRepo();
    const foreign = path.join(repo, "not-ours");
    git(["worktree", "add", "-b", "feat/somebody-elses", foreign], repo);
    git(["worktree", "lock", foreign], repo);

    expect(await sweep([], { list: lister, roots: [repo] })).toEqual([]);
  });
});

describe("reclaiming", () => {
  it("removes the worktree and deletes the branch", async () => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);
    const [entry] = await sweep([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 });

    expect((await reclaimWorktree(entry!)).ok).toBe(true);

    expect(fs.existsSync(worktree)).toBe(false);
    expect(git(["branch", "--list", "agent-chat/scout"], repo)).toBe("");
  });

  it("refuses anything the sweep did not call reclaimable", async () => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);
    fs.writeFileSync(path.join(worktree, "scratch.txt"), "unsaved\n");
    const [entry] = await sweep([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 });

    const result = await reclaimWorktree(entry!);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/holds-work/);
    expect(fs.existsSync(worktree)).toBe(true);
  });

  it("refuses an untracked file that status.showUntrackedFiles=no hides", async () => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);
    git(["config", "status.showUntrackedFiles", "no"], worktree);
    fs.writeFileSync(path.join(worktree, "notes.txt"), "draft\n");
    const [entry] = await sweep([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 });

    const result = await reclaimWorktree(entry!);

    expect(entry?.status).toBe("holds-work");
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(path.join(worktree, "notes.txt"), "utf8")).toBe("draft\n");
  });

  it("refuses a tree whose gitdir is broken, and keeps its files and branch", async () => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(repo, "missing-gitdir")}\n`);
    fs.writeFileSync(path.join(worktree, "notes.txt"), "draft\n");
    const [entry] = await sweep([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 });

    const result = await reclaimWorktree(entry!);

    expect(entry?.detail).toMatch(/could not read git status/);
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(worktree, "notes.txt"))).toBe(true);
    expect(git(["branch", "--list", "agent-chat/scout"], repo)).toContain("agent-chat/scout");
  });

  it("destroys it anyway when a human forces it", async () => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);
    fs.writeFileSync(path.join(worktree, "scratch.txt"), "unsaved\n");
    const [entry] = await sweep([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 });

    expect((await reclaimWorktree(entry!, { force: true })).ok).toBe(true);
    expect(fs.existsSync(worktree)).toBe(false);
  });
});
