import type { RulePlacement, TaskClass } from "./types.js";

/** A task in the rule-ready pool at a week's start (the `pool_snapshot` row). */
export interface PoolTask {
  taskId: string;
  class: TaskClass | null;
  /**
   * Lower is picked first. Today the caller passes the task's `priority`, as E1 did; once the owner's `rank`
   * (F6) exists it passes that. Null sorts after every ranked task.
   */
  rank: number | null;
  createdAt: string;
}

export interface RulePick {
  /** The whole pool in rule order. */
  ranked: readonly string[];
  /** The first K of `ranked`. */
  topK: readonly string[];
}

const CLASS_ORDER: Readonly<Record<TaskClass, number>> = { product: 0, upkeep: 1 };
const UNCLASSED = 2;

function classOrder(task: PoolTask): number {
  return task.class === null ? UNCLASSED : CLASS_ORDER[task.class];
}

function byRule(a: PoolTask, b: PoolTask): number {
  return (
    classOrder(a) - classOrder(b) ||
    (a.rank ?? Number.POSITIVE_INFINITY) - (b.rank ?? Number.POSITIVE_INFINITY) ||
    Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
    (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)
  );
}

/**
 * E1's simple rule: product before upkeep, then rank ascending, then oldest first, and take K. K is the number
 * of distinct tasks first dispatched that week. Ties fall to the task id, so the pick never depends on input order.
 */
export function rulePick(pool: readonly PoolTask[], k: number): RulePick {
  const ranked = [...pool].sort(byRule).map((t) => t.taskId);
  return { ranked, topK: ranked.slice(0, Math.max(0, k)) };
}

/** Where the rule put one task: its position as a share of the pool, and whether it made the top K. Null when outside the pool. */
export function rulePlacement(pick: RulePick, taskId: string): RulePlacement | null {
  const index = pick.ranked.indexOf(taskId);
  if (index < 0) return null;
  return { rankPct: index / pick.ranked.length, inTopK: index < pick.topK.length };
}
