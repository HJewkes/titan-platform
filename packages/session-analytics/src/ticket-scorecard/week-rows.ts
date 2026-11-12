import { redFlags, type RedFlag, type ScorecardThresholds } from "./red-flags.js";
import { isoWeek } from "./stats.js";
import type { TaskRow } from "./types.js";
import { weekMetrics, type WeekMetrics } from "./week-metrics.js";

/** The breakdowns a week is cut by. `seat` waits for F12 `dispatch_rule`; until then the dispatcher is the spawner. */
const WEEK_DIMENSIONS = ["all", "initiative", "dispatcher"] as const;
export type WeekDimension = (typeof WEEK_DIMENSIONS)[number];

/** One weekly series cell, keyed on (isoWeek, dimension, key). */
export interface WeekRow {
  isoWeek: string;
  dimension: WeekDimension;
  key: string;
  metrics: WeekMetrics;
  redFlags: RedFlag[];
}

function keyOf(row: TaskRow, dimension: WeekDimension): string {
  if (dimension === "initiative") return row.initiative;
  if (dimension === "dispatcher") return row.dispatcher;
  return "all";
}

function cellOrder(a: WeekRow, b: WeekRow): number {
  const left = `${a.isoWeek}\u0000${a.dimension}\u0000${a.key}`;
  const right = `${b.isoWeek}\u0000${b.dimension}\u0000${b.key}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

function taskOrder(a: TaskRow, b: TaskRow): number {
  const left = `${a.initiative}/${a.taskId}`;
  const right = `${b.initiative}/${b.taskId}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Every weekly cell over the task rows, each task in the ISO (UTC) week of its first dispatch. The rows are
 * sorted first, so the cells and their figures do not depend on the order the rows arrive in.
 */
export function weekRows(rows: readonly TaskRow[], thresholds: ScorecardThresholds): WeekRow[] {
  const cells = new Map<string, { isoWeek: string; dimension: WeekDimension; key: string; rows: TaskRow[] }>();
  for (const row of [...rows].sort(taskOrder)) {
    const week = isoWeek(row.firstDispatchTs);
    for (const dimension of WEEK_DIMENSIONS) {
      const key = keyOf(row, dimension);
      const id = `${week}\u0000${dimension}\u0000${key}`;
      const cell = cells.get(id) ?? { isoWeek: week, dimension, key, rows: [] };
      cell.rows.push(row);
      cells.set(id, cell);
    }
  }
  return [...cells.values()]
    .map(({ rows: cellRows, ...cell }) => {
      const metrics = weekMetrics(cellRows);
      return { ...cell, metrics, redFlags: redFlags(metrics, thresholds) };
    })
    .sort(cellOrder);
}
