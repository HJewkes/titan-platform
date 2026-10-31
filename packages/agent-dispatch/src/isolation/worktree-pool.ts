import path from "node:path";
import { DEFAULT_WORKTREE_BUDGET, runGit } from "@titan-design/worktree";
import { isReviewerTreeName } from "./reviewer-names.js";
import type { TreeHolders } from "./strategy.js";

/** CC-1040: Shepherd's reviewer cap, so a full reviewer round never waits on implementer slots. */
export const DEFAULT_REVIEWER_WORKTREE_BUDGET = 8;

export type WorktreePool = "implementer" | "reviewer";

const POOL_BUDGET_KEY: Record<WorktreePool, string> = {
  implementer: "worktreeBudget",
  reviewer: "reviewerWorktreeBudget",
};

export const poolExhausted = (pool: WorktreePool, allocated: number, budget: number): string =>
  `${pool} worktree pool exhausted: ${allocated}/${budget} allocated ` +
  `(budget exhausted: ${allocated}/${budget}, ${POOL_BUDGET_KEY[pool]})`;

const UNKNOWN_HOLDER = "unknown";

/** A name reaches this from a model, so it must not be able to escape basePath. */
export const slug = (name: string): string =>
  name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "") || "agent";

/**
 * CC-1469: a refused coordinator needs to know whether its own trees or another seat's fill the
 * pool. Each tree is charged to its agent's direct spawner, largest holder first.
 */
export function heldBy(trees: readonly string[], holders: ReadonlyMap<string, string>): string {
  const counts = new Map<string, number>();
  for (const tree of trees) {
    const holder = holders.get(tree) ?? UNKNOWN_HOLDER;
    counts.set(holder, (counts.get(holder) ?? 0) + 1);
  }
  const ranked = [...counts].sort(([a, m], [b, n]) => n - m || a.localeCompare(b));
  return ranked.length === 0 ? "" : `; held by ${ranked.map(([who, n]) => `${who} ${n}`).join(", ")}`;
}

/** Newest identity first, so a reused name charges its tree to the latest spawner. */
export function treeHoldersOf(
  agents: readonly { name: string; spawnedBy: string }[],
): ReadonlyMap<string, string> {
  const holders = new Map<string, string>();
  for (const { name, spawnedBy } of agents)
    if (!holders.has(slug(name))) holders.set(slug(name), spawnedBy || UNKNOWN_HOLDER);
  return holders;
}

export class WorktreeBudgetExhaustedError extends Error {
  constructor(
    readonly allocated: number,
    readonly budget: number,
    readonly pool: WorktreePool = "implementer",
    holdings = "",
  ) {
    super(poolExhausted(pool, allocated, budget) + holdings);
    this.name = "WorktreeBudgetExhaustedError";
  }
}

/** Budget readers, called on every spawn so a host's config edit applies to the next one. */
export interface PoolBudgets {
  budget?: () => number;
  reviewerBudget?: () => number;
}

export const poolOf = (name: string): WorktreePool =>
  isReviewerTreeName(name) ? "reviewer" : "implementer";

export const poolBudget = (pool: WorktreePool, budgets: PoolBudgets): number =>
  pool === "reviewer"
    ? (budgets.reviewerBudget?.() ?? DEFAULT_REVIEWER_WORKTREE_BUDGET)
    : (budgets.budget?.() ?? DEFAULT_WORKTREE_BUDGET);

/** Live worktrees under basePath, from git itself rather than a parallel table. */
async function allocatedPaths(gitRoot: string, basePath: string): Promise<string[]> {
  const out = await runGit(["worktree", "list", "--porcelain"], gitRoot);
  if (out === null) return [];
  const base = path.resolve(gitRoot, basePath) + path.sep;
  return out
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length).trim()))
    .filter((dir) => dir.startsWith(base));
}

export interface PoolUse {
  pool: WorktreePool;
  allocated: number;
  budget: number;
  /** Directory names of the pool's trees. */
  trees: string[];
}

/** CC-1040: trees under basePath in the same pool as `agentName`, against that pool's budget. */
export async function poolUse(
  gitRoot: string,
  basePath: string,
  agentName: string,
  budgets: PoolBudgets,
): Promise<PoolUse> {
  const pool = poolOf(agentName);
  const trees = (await allocatedPaths(gitRoot, basePath))
    .map((dir) => path.basename(dir))
    .filter((name) => poolOf(name) === pool);
  return { pool, allocated: trees.length, budget: poolBudget(pool, budgets), trees };
}

export const holdingsOf = (use: PoolUse, holders: TreeHolders | undefined): string =>
  heldBy(use.trees, holders?.() ?? new Map<string, string>());
