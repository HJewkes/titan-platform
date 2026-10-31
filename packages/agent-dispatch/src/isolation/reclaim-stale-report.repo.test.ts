import fs from "node:fs";
import path from "node:path";
import { RECLAIM_GRACE_MS } from "@titan-design/worktree";
import { afterEach, expect, it, vi } from "vitest";
import { git, makeRepo, removeTempDirs } from "./fixtures/git-repo.js";
import { memoryStore } from "./fixtures/held-store.js";
import { reclaim, sweepWorktrees } from "./sweep.js";
import { createWorktreeStrategy } from "./worktree.js";

/**
 * TP-640 P2. `sweepWorktrees` classifies a tree, and `reclaim` acts on that
 * report later. Work written in between must not be destroyed on the strength
 * of a stale "reclaimable".
 */

vi.setConfig({ testTimeout: 30_000 });

const branch = "agent-chat/worker";
const agentId = "synthetic-reclaim-adapter";
const strategy = createWorktreeStrategy();

afterEach(removeTempDirs);

async function sweptReclaimable() {
  const repo = makeRepo();
  const base = git(["rev-parse", "HEAD"], repo);
  const tree = path.join(repo, ".worktrees", "worker");
  git(["worktree", "add", "-qb", branch, tree], repo);
  const store = memoryStore();
  store.record(agentId, { cwd: tree, ref: { branch, worktree: tree, gitRoot: repo, base } });
  const report = await sweepWorktrees([], {
    store,
    roots: [repo],
    list: async (cwd) => git(["worktree", "list", "--porcelain"], cwd),
    now: () => RECLAIM_GRACE_MS + 1,
  });
  expect(report).toHaveLength(1);
  const entry = report[0]!;
  expect(entry).toMatchObject({ gitRoot: repo, worktree: tree, branch, status: "reclaimable" });
  return { repo, tree, entry, store };
}

function writeLateWork(kind: "untracked" | "ignored" | "commit", repo: string, tree: string): string {
  const note = path.join(tree, "late-owned-note.txt");
  if (kind === "ignored")
    fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "late-owned-note.txt\n");
  fs.writeFileSync(note, "harmless owned note\n");
  if (kind === "commit") {
    git(["add", "late-owned-note.txt"], tree);
    git(["commit", "-qm", "owned late commit"], tree);
    expect(git(["rev-list", "--count", `main..${branch}`], repo)).toBe("1");
  }
  return note;
}

it.each(["untracked", "ignored", "commit"] as const)(
  "refuses to reclaim a tree that gained %s work after the sweep, and keeps it",
  async (kind) => {
    const { repo, tree, entry, store } = await sweptReclaimable();
    const note = writeLateWork(kind, repo, tree);
    const tip = git(["rev-parse", branch], repo);

    const result = await reclaim(entry, { store, strategy });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain(branch);
    expect(fs.readFileSync(note, "utf8")).toBe("harmless owned note\n");
    expect(git(["rev-parse", branch], repo)).toBe(tip);
    expect(store.held().has(branch)).toBe(true);
  }
);

it("reclaims a tree that is still clean when reclaim runs", async () => {
  const { repo, tree, entry, store } = await sweptReclaimable();

  const result = await reclaim(entry, { store, strategy });

  expect(result).toEqual({ ok: true });
  expect(fs.existsSync(tree)).toBe(false);
  expect(git(["branch", "--list", branch], repo)).toBe("");
  expect(store.held().has(branch)).toBe(false);
});

it("still discards late work when a human forces the reclaim", async () => {
  const { repo, tree, entry, store } = await sweptReclaimable();
  writeLateWork("untracked", repo, tree);

  expect(await reclaim(entry, { store, strategy, force: true })).toEqual({ ok: true });
  expect(fs.existsSync(tree)).toBe(false);
});

it("reports a built tree whose only ignored files are tsbuildinfo as reclaimable", async () => {
  const repo = makeRepo();
  const allocation = await strategy.allocate({ agentId, agentName: "built", baseCwd: repo });
  fs.writeFileSync(path.join(repo, ".git", "info", "exclude"), ".worktrees/\n*.tsbuildinfo\n");
  fs.writeFileSync(path.join(allocation.cwd, "tsconfig.test.tsbuildinfo"), "{}\n");
  const store = memoryStore();
  store.record(agentId, allocation);

  const report = await sweepWorktrees([], {
    store,
    roots: [repo],
    list: async (cwd) => git(["worktree", "list", "--porcelain"], cwd),
    now: () => RECLAIM_GRACE_MS + 1,
  });

  expect(report).toHaveLength(1);
  expect(report[0]).toMatchObject({
    worktree: allocation.cwd,
    branch: "agent-chat/built",
    status: "reclaimable",
  });
});
