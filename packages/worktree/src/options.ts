import type { WorktreeAddRunner } from "./add.js";
import type { SetupRunner } from "./setup.js";

export const DEFAULT_WORKTREE_BUDGET = 3;
export const DEFAULT_BASE_PATH = ".worktrees";
/** Ownership marker: the sweep treats only branches carrying this prefix as its own. */
export const BRANCH_PREFIX = "agent-chat/";
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/**
 * Grace window between an agent exiting and its worktree becoming reclaimable.
 *
 * It guards the window between an agent exiting and a human noticing the
 * unpushed commits it left behind. Release does `git branch -D`, so reclaiming
 * inside that window turns "I'll look at it in a minute" into a dangling commit.
 * Anchored on the exit timestamp, not on wall clock since allocation.
 *
 * This window and the dirty/unmerged refusal are the two things most likely to
 * be dropped as incidental. They are not: both exist because work was lost.
 */
export const RECLAIM_GRACE_MS = 120_000;

export interface WorktreeOptions {
  /** Relative to the git root. */
  basePath?: string;
  /** Per-repository cap on allocated worktrees. A function is read on every allocation. */
  budget?: number | (() => number);
  branchPrefix?: string;
  /** Bound on fetching origin's default branch before cutting a new one. */
  fetchTimeoutMs?: number;
  /** Bound on one `git worktree add`; the add is killed and the repo's queue moves on when it passes. */
  addTimeoutMs?: number;
  /** Runs each `git worktree add`; tests inject one to observe how adds interleave. */
  runWorktreeAdd?: WorktreeAddRunner;
  /** Runs the repository's declared setup step; tests inject one so no real install runs. */
  runSetup?: SetupRunner;
}

export const basePathOf = (opts: WorktreeOptions): string => opts.basePath ?? DEFAULT_BASE_PATH;

export const branchPrefixOf = (opts: WorktreeOptions): string => opts.branchPrefix ?? BRANCH_PREFIX;

export function budgetOf(opts: WorktreeOptions): number {
  const { budget } = opts;
  return typeof budget === "function" ? budget() : budget ?? DEFAULT_WORKTREE_BUDGET;
}

/** A name reaches this from a model, so it must not be able to escape basePath. */
export const slug = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "") || "agent";

export const branchFor = (name: string, opts: WorktreeOptions = {}): string => `${branchPrefixOf(opts)}${slug(name)}`;
