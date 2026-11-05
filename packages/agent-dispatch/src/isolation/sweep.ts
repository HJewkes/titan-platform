import {
  agentWorktreesIn as platformAgentWorktreesIn,
  BRANCH_PREFIX,
  describeRefusal,
  listWorktreesPorcelain,
  sweepWorktrees as platformSweepWorktrees,
  type GitLister,
  type HeldWorktree,
  type SweepOwner,
  type SweptWorktree,
} from "@titan-design/worktree";
import { stoppedAt } from "../roster/fold.js";
import type { AgentIdentity } from "../roster/types.js";
import type { Allocation, IsolationStrategy } from "./strategy.js";
import { occupantOf } from "./tenancy.js";
import { inspectForRelease } from "./worktree.js";

/**
 * Find the worktrees a host is holding, and say which ones nobody is using.
 *
 * WHY THIS EXISTS SEPARATELY FROM RELEASE (CC-80). Release is driven by retire, and retire by a
 * person deciding they are done. The leak is the case where nobody ever decides: an agent exits, is
 * never retired, and holds its worktree and branch indefinitely.
 *
 * TWO SOURCES, because neither alone is complete: the host's store of allocations it still holds,
 * and `git worktree list` in each repository those point at, which catches a tree from before the
 * store existed or one whose retire refused and left the branch behind.
 *
 * OWNERSHIP IS THE BRANCH PREFIX, not the path: it is what the strategy writes and nothing else
 * creates. That keeps the sweep off other tools' agent worktrees, which sit on ordinary branch
 * names and are usually locked.
 */

export type { GitLister, SweepStatus, SweptWorktree } from "@titan-design/worktree";

export interface HeldAllocation {
  agentId: string;
  allocation: Allocation;
}

/** The host's record of worktree allocations it has not released. */
export interface HeldAllocationStore {
  /** Keyed by branch, so git can be joined to it. */
  held(): ReadonlyMap<string, HeldAllocation>;
  /** Stops the next sweep re-reporting an allocation that is already gone. */
  forget(agentId: string): void;
}

/** Every worktree in `gitRoot` carrying an agent branch, from git itself. */
export async function agentWorktreesIn(
  gitRoot: string,
  list: GitLister,
): Promise<{ worktree: string; branch: string }[]> {
  return platformAgentWorktreesIn(gitRoot, list, BRANCH_PREFIX);
}

export interface SweepOptions {
  store: HeldAllocationStore;
  /** Repositories to scan beyond the ones the store names; catches a tree nothing on record points at. */
  roots?: readonly string[];
  list?: GitLister;
  now?: () => number;
}

export const porcelain: GitLister = listWorktreesPorcelain;

/** The owner of a found tree: a live agent standing in it wins over the agent its branch names (CC-277). */
function ownerOf(
  roster: readonly AgentIdentity[],
): (found: { worktree: string; branch: string }) => SweepOwner | undefined {
  const byBranch = new Map(roster.map((agent) => [`${BRANCH_PREFIX}${agent.name}`, agent]));
  return ({ worktree, branch }) => {
    const agent = occupantOf(worktree, roster) ?? byBranch.get(branch);
    if (agent === undefined) return undefined;
    const exitedAt = stoppedAt(agent);
    return {
      agentId: agent.agentId,
      name: agent.name,
      state: agent.state,
      lastEventAt: agent.lastEventAt,
      ...(exitedAt === undefined ? {} : { exitedAt }),
    };
  };
}

function heldWorktrees(held: ReadonlyMap<string, HeldAllocation>): HeldWorktree[] {
  return [...held].flatMap(([branch, { allocation }]) => {
    const gitRoot = allocation.ref?.["gitRoot"];
    const base = allocation.ref?.["base"];
    if (gitRoot === undefined) return [];
    return [{ gitRoot, branch, ...(base === undefined ? {} : { base }) }];
  });
}

const baseOf = (held: HeldAllocation | undefined): string => held?.allocation.ref?.["base"] ?? "HEAD";

/**
 * The package judges a tree's files by its own ignored-file list, which misses build outputs and
 * paid data, so its lifecycle verdict is kept and the work verdict is re-made under dispatch's policy
 * (`unsaved-work.ts`). An unknown owner is not a reason to destroy commits. TP-4688 gives the
 * package a policy hook; this goes when dispatch adopts it.
 */
async function judgeByDispatchPolicy(
  entry: SweptWorktree,
  held: ReadonlyMap<string, HeldAllocation>,
): Promise<SweptWorktree> {
  if (entry.status === "held" || entry.status === "in-grace") return entry;
  const base = baseOf(held.get(entry.branch));
  const safety = await inspectForRelease(entry.gitRoot, entry.worktree, entry.branch, base);
  const unsafe = safety.dirty || safety.unmerged;
  const reasons = [safety.dirty && "uncommitted changes", safety.unmerged && "commits that exist nowhere else"];
  const idle =
    entry.agent === undefined
      ? "no agent in the log claims this branch, and it holds nothing"
      : `${entry.agent.name} is ${entry.agent.state}, and it holds nothing`;
  return {
    ...entry,
    status: unsafe ? "holds-work" : "reclaimable",
    detail: unsafe ? reasons.filter(Boolean).join(" and ") : idle,
  };
}

/**
 * Every agent worktree this machine is holding, classified. `roster` is passed in rather than
 * read here: the log lives behind the broker, and a sweep that could not run without one would be
 * useless in exactly the situation it is for.
 */
export async function sweepWorktrees(
  roster: readonly AgentIdentity[],
  options: SweepOptions,
): Promise<SweptWorktree[]> {
  // The clock is read before the store, so an allocation written after `now` is never judged by it.
  const now = (options.now ?? Date.now)();
  const held = options.store.held();
  const swept = await platformSweepWorktrees({
    ...(options.roots === undefined ? {} : { roots: options.roots }),
    held: heldWorktrees(held),
    branchPrefix: BRANCH_PREFIX,
    list: options.list ?? porcelain,
    now: () => now,
    ownerOf: ownerOf(roster),
  });
  return Promise.all(swept.map((entry) => judgeByDispatchPolicy(entry, held)));
}

export interface ReclaimOptions {
  store: HeldAllocationStore;
  /** The worktree strategy the host built; it does the removal. */
  strategy: IsolationStrategy;
  force?: boolean;
}

/**
 * Destroy one swept worktree and its branch, and forget the allocation. Refuses anything not
 * `reclaimable` unless forced, so the classification is the guard rather than advice, and re-checks
 * the work before acting on it (TP-640).
 */
export async function reclaim(
  entry: SweptWorktree,
  { store, strategy, force = false }: ReclaimOptions,
): Promise<{ ok: boolean; reason?: string }> {
  if (entry.status !== "reclaimable" && !force)
    return { ok: false, reason: `${entry.branch} is ${entry.status} — ${entry.detail}` };

  const held = store.held().get(entry.branch);
  const allocation: Allocation = held?.allocation ?? {
    cwd: entry.worktree,
    ref: { branch: entry.branch, worktree: entry.worktree, gitRoot: entry.gitRoot },
  };
  // The report may be stale: work written after the sweep classified it is not in it.
  if (!force) {
    const safety = await inspectForRelease(entry.gitRoot, entry.worktree, entry.branch, baseOf(held));
    if (safety.dirty || safety.unmerged)
      return { ok: false, reason: `${entry.branch} gained work since the sweep — ${describeRefusal(safety)}` };
  }
  // Forced at the strategy: the grace window was judged in the sweep, on a stop time this call
  // site does not have, and the work check just re-ran.
  const released = await strategy.release(
    { agentId: held?.agentId ?? "", agentName: entry.agent?.name ?? entry.branch, baseCwd: entry.gitRoot },
    allocation,
    { force: true },
  );
  if (released && held !== undefined) store.forget(held.agentId);
  return released ? { ok: true } : { ok: false, reason: `git would not release ${entry.worktree}` };
}
