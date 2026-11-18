import { isoWeek, readPoolSnapshot, readTaskRows, rulePick, rulePlacement, taskRow, type PoolTask, type TaskRow, type TaskRowInput } from "@titan-design/session-analytics";
import type { Db } from "@titan-design/store-sqlite";
import { assembleInputs } from "./assemble.js";
import type { Indexes, RowSources } from "./load.js";

function keyOf(row: Pick<TaskRow, "initiative" | "taskId">): string {
  return `${row.initiative}/${row.taskId}`;
}

function bareRows(inputs: ReadonlyMap<string, TaskRowInput>): Map<string, TaskRow> {
  const rows = new Map<string, TaskRow>();
  for (const [key, input] of inputs) {
    const row = taskRow(input);
    if (row !== null) rows.set(key, row);
  }
  return rows;
}

function countByWeek(weekOf: ReadonlyMap<string, string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const week of weekOf.values()) counts.set(week, (counts.get(week) ?? 0) + 1);
  return counts;
}

interface WeekPlan {
  /** Every dispatched task's week after this run. */
  weekOf: Map<string, string>;
  /** K per week: the distinct tasks first dispatched in it. */
  k: Map<string, number>;
  /** Tasks outside the dirty set whose rule placement moved because their week's K did. */
  extra: Set<string>;
}

/** A new dispatch changes its week's K, and with it every placement in that week; those tasks join the recompute. */
function planWeeks(stored: readonly TaskRow[], fresh: ReadonlyMap<string, TaskRow>, pools: (week: string) => readonly PoolTask[]): WeekPlan {
  const before = new Map(stored.map((r) => [keyOf(r), isoWeek(r.firstDispatchTs)]));
  const weekOf = new Map(before);
  for (const [key, row] of fresh) weekOf.set(key, isoWeek(row.firstDispatchTs));
  const k = countByWeek(weekOf);
  const kBefore = countByWeek(before);
  const moved = new Set([...k].filter(([week, n]) => kBefore.get(week) !== n && pools(week).length > 0).map(([week]) => week));
  const extra = new Set([...weekOf].filter(([key, week]) => moved.has(week) && !fresh.has(key)).map(([key]) => key));
  return { weekOf, k, extra };
}

/**
 * The rows of the dirty tasks, each placed by E1's rule in its dispatch week's pool snapshot, plus the rows of any task
 * whose placement moved with its week's K. A week with no snapshot places nothing: its rule columns stay not measured.
 */
export function computeRows(store: Db, s: RowSources, idx: Indexes, keys: ReadonlySet<string>): TaskRow[] {
  const snapshots = new Map<string, PoolTask[]>();
  const pools = (week: string) => snapshots.get(week) ?? snapshots.set(week, readPoolSnapshot(store, week)).get(week)!;
  const inputs = assembleInputs(s, idx, keys);
  const plan = planWeeks(readTaskRows(store), bareRows(inputs), pools);
  for (const [key, input] of assembleInputs(s, idx, plan.extra)) inputs.set(key, input);
  const rows: TaskRow[] = [];
  for (const [key, input] of [...inputs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const week = plan.weekOf.get(key);
    const pool = week === undefined ? [] : pools(week);
    const placement = pool.length === 0 ? null : rulePlacement(rulePick(pool, plan.k.get(week!) ?? 0), input.task.taskId);
    const row = taskRow(placement === null ? input : { ...input, rule: placement });
    if (row !== null) rows.push(row);
  }
  return rows;
}
