import { execFileSync } from "node:child_process";
import path from "node:path";
import { gitChildEnv } from "./git.js";
import { removeWorktree } from "./layout.js";
import { branchPrefixOf, RECLAIM_GRACE_MS } from "./options.js";
import { inspectForRelease } from "./release-safety.js";

/**
 * Find the worktrees an allocator is holding, and say which ones nobody is using.
 *
 * Release is driven by a person deciding they are done. The leak is the case
 * where nobody decides: an agent exits, is never released, and holds its
 * worktree and branch indefinitely.
 *
 * Ownership is the branch prefix, not the path: the prefix is what the allocator
 * writes and nothing else creates. That keeps the sweep off other tools' agent
 * worktrees, which sit on ordinary branch names and are usually locked.
 */

/** Where a worktree sits in the lifecycle, and therefore what may be done to it. */
export type SweepStatus =
  /** Its agent is still running. Nothing to do, and nothing safe to do. */
  | "held"
  /** Its agent has exited, but inside the window that protects unnoticed work. */
  | "in-grace"
  /** Uncommitted changes, or commits that exist nowhere else. Needs a person. */
  | "holds-work"
  /** Nobody is using it and nothing would be lost. `reclaimWorktree` takes these. */
  | "reclaimable";

/** The agent a caller says owns a found worktree. */
export interface SweepOwner {
  agentId: string;
  name: string;
  state: string;
  lastEventAt: number;
  exitedAt?: number;
}

/** An allocation the caller believes it still holds. */
export interface HeldWorktree {
  gitRoot: string;
  branch: string;
  /** The commit the branch was cut from; release safety compares against it when there is no remote. */
  base?: string;
}

export interface FoundWorktree {
  gitRoot: string;
  worktree: string;
  branch: string;
}

export interface SweptWorktree extends FoundWorktree {
  status: SweepStatus;
  /** Absent when no owner was found for the worktree. */
  agent?: { agentId: string; name: string; state: string; lastEventAt: number };
  /** One line of why it is in this state, for a human reading the report. */
  detail: string;
}

export type GitLister = (gitRoot: string) => Promise<string>;

export interface SweepOptions {
  /** Repositories to scan beyond the ones `held` names, which catches a tree no record points at. */
  roots?: readonly string[];
  held?: readonly HeldWorktree[];
  /** Joins a found worktree to its agent; the caller owns the roster. */
  ownerOf?: (found: FoundWorktree) => SweepOwner | undefined;
  branchPrefix?: string;
  list?: GitLister;
  now?: () => number;
}

const porcelain: GitLister = async (gitRoot) =>
  execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: gitRoot, encoding: "utf8", env: gitChildEnv() });

interface ListedWorktree {
  worktree?: string;
  branch?: string;
  locked: boolean;
}

const parseBlock = (block: string): ListedWorktree => ({
  worktree: block.match(/^worktree (.+)$/m)?.[1]?.trim(),
  branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1]?.trim(),
  locked: /^locked/m.test(block),
});

/** Every unlocked worktree in `gitRoot` whose branch carries `branchPrefix`, from git itself. */
export async function agentWorktreesIn(
  gitRoot: string,
  list: GitLister = porcelain,
  branchPrefix: string = branchPrefixOf({})
): Promise<{ worktree: string; branch: string }[]> {
  const out = await list(gitRoot).catch(() => "");
  return (
    out
      .split("\n\n")
      .map(parseBlock)
      .filter((e): e is Required<ListedWorktree> => e.worktree !== undefined && e.branch !== undefined)
      // Locked is another tool's "do not touch"; honour it rather than report a reclaim we would refuse.
      .filter((e) => !e.locked && e.branch.startsWith(branchPrefix))
      .map(({ worktree, branch }) => ({ worktree: path.resolve(worktree), branch }))
  );
}

/** Live means someone is in it; anything else has stopped and may be reclaimable. */
export const isLive = (state: string): boolean => state === "live" || state === "spawning";

function classifyByOwner(
  owner: SweepOwner | undefined,
  now: number
): { status: SweepStatus; detail: string } | undefined {
  if (owner === undefined) return undefined;
  if (isLive(owner.state)) return { status: "held", detail: `${owner.name} is ${owner.state}` };
  const since = now - (owner.exitedAt ?? owner.lastEventAt);
  if (since >= RECLAIM_GRACE_MS) return undefined;
  return {
    status: "in-grace",
    detail: `${owner.name} stopped ${Math.round(since / 1000)}s ago; reclaimable after ${RECLAIM_GRACE_MS / 1000}s`,
  };
}

function idleDetail(owner: SweepOwner | undefined): string {
  return owner === undefined
    ? "no agent in the log claims this branch, and it holds nothing"
    : `${owner.name} is ${owner.state}, and it holds nothing`;
}

/** An unknown owner is not a reason to destroy commits; the dirty/unmerged check decides. */
async function classify(
  found: FoundWorktree,
  owner: SweepOwner | undefined,
  base: string,
  now: number
): Promise<SweptWorktree> {
  const agent = owner && {
    agentId: owner.agentId,
    name: owner.name,
    state: owner.state,
    lastEventAt: owner.lastEventAt,
  };
  const withAgent = { ...found, ...(agent ? { agent } : {}) };
  const byOwner = classifyByOwner(owner, now);
  if (byOwner) return { ...withAgent, ...byOwner };

  const safety = await inspectForRelease(found.gitRoot, found.worktree, found.branch, base);
  if (!safety.dirty && !safety.unmerged) return { ...withAgent, status: "reclaimable", detail: idleDetail(owner) };
  const unsaved = safety.checked.find((check) => check.name === "dirty" && !check.ok)?.detail;
  const detail = [unsaved, safety.unmerged && "commits that exist nowhere else"]
    .filter(Boolean)
    .join(" and ");
  return { ...withAgent, status: "holds-work", detail };
}

/** Every allocator worktree in the named and held repositories, classified. */
export async function sweepWorktrees(options: SweepOptions = {}): Promise<SweptWorktree[]> {
  const now = (options.now ?? Date.now)();
  const held = new Map((options.held ?? []).map((h) => [h.branch, h]));
  const roots = new Set<string>([...(options.roots ?? []), ...[...held.values()].map((h) => h.gitRoot)]);
  const prefix = options.branchPrefix ?? branchPrefixOf({});

  const swept: SweptWorktree[] = [];
  for (const gitRoot of roots) {
    for (const { worktree, branch } of await agentWorktreesIn(gitRoot, options.list ?? porcelain, prefix)) {
      const found = { gitRoot, worktree, branch };
      swept.push(await classify(found, options.ownerOf?.(found), held.get(branch)?.base ?? "HEAD", now));
    }
  }
  return swept;
}

/**
 * Destroy one swept worktree and its branch.
 *
 * Refuses anything not `reclaimable` unless forced, so the classification is the
 * guard rather than advice. The grace window and the safety check already ran in
 * the sweep, against the report the caller read, so they are not re-derived here.
 */
export async function reclaimWorktree(
  entry: SweptWorktree,
  options: { force?: boolean } = {}
): Promise<{ ok: boolean; reason?: string }> {
  if (entry.status !== "reclaimable" && options.force !== true)
    return { ok: false, reason: `${entry.branch} is ${entry.status}: ${entry.detail}` };
  const refused = await removeWorktree(entry.gitRoot, entry.worktree, entry.branch, options);
  return refused === undefined ? { ok: true } : { ok: false, reason: refused };
}
