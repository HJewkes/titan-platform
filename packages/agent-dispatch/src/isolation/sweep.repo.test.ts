import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RECLAIM_GRACE_MS } from "@titan-design/worktree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentIdentity } from "../roster/types.js";
import { git, makeRepo, removeTempDirs } from "./fixtures/git-repo.js";
import { memoryStore, type MemoryStore } from "./fixtures/held-store.js";
import {
  reclaim as reclaimWith,
  sweepWorktrees as sweepWith,
  type GitLister,
  type SweepOptions,
  type SweptWorktree,
} from "./sweep.js";
import { createWorktreeStrategy } from "./worktree.js";

/**
 * CC-80. Retire releases a worktree when a person decides they are done. The
 * leak is the case where nobody decides — an agent exits, is never retired, and
 * holds its worktree and branch indefinitely. These prove the sweep finds that,
 * and that every guard which stops it destroying work still stands.
 */

vi.setConfig({ testTimeout: 30_000 });

const strategy = createWorktreeStrategy();
const lister: GitLister = async (gitRoot) => git(["worktree", "list", "--porcelain"], gitRoot);
const extras: string[] = [];
let store: MemoryStore;

const sweepWorktrees = (roster: readonly AgentIdentity[], options: Omit<SweepOptions, "store">) =>
  sweepWith(roster, { store, ...options });

const reclaim = (entry: SweptWorktree | undefined, force = false) =>
  reclaimWith(found(entry), { store, strategy, force });

function found(entry: SweptWorktree | undefined): SweptWorktree {
  if (entry === undefined) throw new Error("the sweep reported nothing");
  return entry;
}

/** An agent that allocated a worktree and left its record behind. */
async function abandonedWorktree(repo: string, name = "scout", agentId = "a1"): Promise<string> {
  const allocation = await strategy.allocate({ agentId, agentName: name, baseCwd: repo });
  store.record(agentId, allocation);
  return allocation.cwd;
}

const identity = (over: Partial<AgentIdentity> = {}): AgentIdentity => ({
  agentId: "a1",
  name: "scout",
  profile: "implementer",
  state: "exited",
  origin: "spawned",
  spawnedBy: "human",
  spawnedAt: 0,
  brief: "",
  cwd: "",
  isolation: "worktree",
  surface: "headless",
  sessionId: "",
  lastEventAt: 0,
  generation: 1,
  ...over,
});

beforeEach(() => {
  store = memoryStore();
});

afterEach(() => {
  removeTempDirs();
  for (const dir of extras.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("finding what nobody is using", () => {
  it("reports a worktree whose agent exited and was never retired", async () => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);

    const swept = await sweepWorktrees([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 });

    expect(swept).toHaveLength(1);
    expect(swept[0]?.status).toBe("reclaimable");
    expect(swept[0]?.worktree).toBe(worktree);
    expect(swept[0]?.agent?.name).toBe("scout");
  });

  it("leaves a worktree alone while its agent is still running", async () => {
    const repo = makeRepo();
    await abandonedWorktree(repo);

    const swept = await sweepWorktrees([identity({ state: "live" })], { list: lister });

    expect(swept[0]?.status).toBe("held");
    expect(swept[0]?.detail).toMatch(/scout is live/);
  });

  it("holds off inside the grace window that protects work nobody has noticed", async () => {
    const repo = makeRepo();
    await abandonedWorktree(repo);

    const swept = await sweepWorktrees([identity({ lastEventAt: 1000 })], {
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

    const swept = await sweepWorktrees([identity({ exitedAt, lastEventAt: refusedRetireAt })], {
      list: lister,
      now: () => exitedAt + RECLAIM_GRACE_MS + 1,
    });

    expect(swept[0]?.status).toBe("reclaimable");
  });

  it("times the grace window from the detach for an agent that never exited", async () => {
    const repo = makeRepo();
    await abandonedWorktree(repo);
    const detachedAt = 1_000_000;

    const swept = await sweepWorktrees(
      [identity({ state: "detached", detachedAt, lastEventAt: detachedAt })],
      {
        list: lister,
        now: () => detachedAt + RECLAIM_GRACE_MS / 2,
      }
    );

    expect(swept[0]?.status).toBe("in-grace");
  });

  it("reclaims an agent with no exit time once its detach is old, whatever row came after", async () => {
    const repo = makeRepo();
    await abandonedWorktree(repo);
    const detachedAt = 1_000_000;
    const refusedRetireAt = detachedAt + 100_000;

    const swept = await sweepWorktrees(
      [identity({ state: "detached", detachedAt, lastEventAt: refusedRetireAt })],
      { list: lister, now: () => detachedAt + RECLAIM_GRACE_MS + 1 }
    );

    expect(swept[0]?.status).toBe("reclaimable");
  });

  it("refuses one holding commits that exist nowhere else", async () => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);
    fs.writeFileSync(path.join(worktree, "feature.ts"), "work\n");
    git(["add", "feature.ts"], worktree);
    git(["commit", "-m", "work"], worktree);

    const swept = await sweepWorktrees([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 });

    expect(swept[0]?.status).toBe("holds-work");
    expect(swept[0]?.detail).toMatch(/exist nowhere else/);
  });

  it("refuses one with uncommitted changes", async () => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);
    fs.writeFileSync(path.join(worktree, "scratch.txt"), "unsaved\n");

    const swept = await sweepWorktrees([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 });

    expect(swept[0]?.status).toBe("holds-work");
    expect(swept[0]?.detail).toMatch(/uncommitted changes/);
  });

  /**
   * A worktree from before the store existed has nothing on record
   * pointing at it, which is why the CLI passes the repo it was run in.
   */
  it("finds one no held allocation points at, when the repo is named", async () => {
    const repo = makeRepo();
    await strategy.allocate({ agentId: "gone", agentName: "ghost", baseCwd: repo });

    const swept = await sweepWorktrees([], { list: lister, roots: [repo], now: () => RECLAIM_GRACE_MS + 1 });

    expect(swept[0]?.branch).toBe("agent-chat/ghost");
    expect(swept[0]?.agent).toBeUndefined();
    expect(swept[0]?.detail).toMatch(/no agent in the log claims this branch/);
  });

  /**
   * Claude Code's own agent worktrees sit on ordinary branch names and are
   * usually locked. They are a different tool's leak; reporting a reclaim here
   * that we would then refuse to perform would be worse than ignoring them.
   */
  it("ignores worktrees another tool owns, including locked ones", async () => {
    const repo = makeRepo();
    const foreign = path.join(repo, "not-ours");
    git(["worktree", "add", "-b", "feat/somebody-elses", foreign], repo);
    git(["worktree", "lock", foreign], repo);

    expect(await sweepWorktrees([], { list: lister, roots: [repo] })).toEqual([]);
  });
});

/**
 * CC-277. Ownership was joined on the branch alone, so an agent working in a
 * tree under a different name (an adopting successor, an isolation-none
 * reviewer) was invisible and its checkout looked reclaimable.
 */
describe("a worktree someone is standing in", () => {
  const now = () => RECLAIM_GRACE_MS + 1;

  it.each([
    ["a successor spawned with worktree: on the predecessor tree", { isolation: "worktree" }],
    ["an isolation-none reviewer whose cwd is the tree", { isolation: "none" }],
  ])("is held for %s, and prune leaves it", async (_label, over) => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);
    const occupant = identity({
      agentId: "a2",
      name: "reviewer",
      state: "live",
      cwd: worktree,
      ...over,
    });

    const swept = await sweepWorktrees([identity(), occupant], { list: lister, now });

    expect(swept[0]?.status).toBe("held");
    expect(swept[0]?.detail).toMatch(/reviewer is live/);
    expect((await reclaim(swept[0])).ok).toBe(false);
    expect(fs.existsSync(worktree)).toBe(true);
  });

  it("matches through a symlinked path to the same directory", async () => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);
    const link = path.join(os.tmpdir(), `sweep-link-${process.pid}`);
    fs.symlinkSync(worktree, link);
    extras.push(link);

    const swept = await sweepWorktrees(
      [identity(), identity({ agentId: "a2", name: "reviewer", state: "spawning", cwd: link })],
      {
        list: lister,
        now,
      }
    );

    expect(swept[0]?.status).toBe("held");
  });

  it("is held for an agent whose cwd is a subdirectory of the tree", async () => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);
    const sub = path.join(worktree, "packages", "app");
    fs.mkdirSync(sub, { recursive: true });

    const swept = await sweepWorktrees(
      [identity(), identity({ agentId: "a2", name: "reviewer", state: "live", cwd: sub })],
      {
        list: lister,
        now,
      }
    );

    expect(swept[0]?.status).toBe("held");
  });

  it("is not held for an agent in a sibling path that shares the tree name as a prefix", async () => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);
    const sibling = `${worktree}b`;
    fs.mkdirSync(sibling);
    extras.push(sibling);

    const swept = await sweepWorktrees(
      [identity(), identity({ agentId: "a2", name: "reviewer", state: "live", cwd: sibling })],
      {
        list: lister,
        now,
      }
    );

    expect(swept[0]?.status).toBe("reclaimable");
  });

  it("neither throws nor holds for an agent whose cwd no longer exists", async () => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);
    const vanished = path.join(os.tmpdir(), `sweep-vanished-${process.pid}`, "gone");

    const swept = await sweepWorktrees(
      [identity(), identity({ agentId: "a2", name: "reviewer", state: "live", cwd: vanished })],
      {
        list: lister,
        now,
      }
    );

    expect(swept[0]?.status).toBe("reclaimable");
    expect(swept[0]?.worktree).toBe(worktree);
  });

  it("does not hold a tree for a detached agent, which counts as finished", async () => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);

    const swept = await sweepWorktrees(
      [
        identity(),
        identity({
          agentId: "a2",
          name: "reviewer",
          state: "detached",
          cwd: worktree,
          lastEventAt: now() - 1,
        }),
      ],
      {
        list: lister,
        now,
      }
    );

    expect(swept[0]?.status).toBe("reclaimable");
  });

  it("does not hold a tree for an agent that has exited", async () => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);

    const swept = await sweepWorktrees(
      [identity(), identity({ agentId: "a2", name: "reviewer", cwd: worktree, lastEventAt: now() - 1 })],
      {
        list: lister,
        now,
      }
    );

    expect(swept[0]?.status).toBe("reclaimable");
  });
});

describe("reclaiming", () => {
  it("keeps the allocation when the strategy will not release", async () => {
    const repo = makeRepo();
    await abandonedWorktree(repo);
    const [entry] = await sweepWorktrees([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 });
    const refusing = { ...strategy, release: async () => false };

    const result = await reclaimWith(found(entry), { store, strategy: refusing });

    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/git would not release/) });
    expect(store.held().size).toBe(1);
  });

  it("removes the worktree, deletes the branch, and forgets the allocation", async () => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);
    const [entry] = await sweepWorktrees([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 });

    expect((await reclaim(entry)).ok).toBe(true);

    expect(fs.existsSync(worktree)).toBe(false);
    expect(git(["branch", "--list", "agent-chat/scout"], repo)).toBe("");
    expect(store.held().size).toBe(0);
  });

  it("refuses anything the sweep did not call reclaimable", async () => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);
    fs.writeFileSync(path.join(worktree, "scratch.txt"), "unsaved\n");
    const [entry] = await sweepWorktrees([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 });

    const result = await reclaim(entry);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/holds-work/);
    expect(fs.existsSync(worktree)).toBe(true);
  });

  it("destroys it anyway when a human forces it", async () => {
    const repo = makeRepo();
    const worktree = await abandonedWorktree(repo);
    fs.writeFileSync(path.join(worktree, "scratch.txt"), "unsaved\n");
    const [entry] = await sweepWorktrees([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 });

    expect((await reclaim(entry, true)).ok).toBe(true);
    expect(fs.existsSync(worktree)).toBe(false);
  });
});
