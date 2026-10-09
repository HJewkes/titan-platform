import type { WorkflowRun } from "@titan-design/workflow";
import { FAILURE_CLASSES, failureClassOf, type FailureClass } from "./failure-class.js";
import { inRange, isoWeek } from "./stats.js";

export interface FailureRow {
  repo: string;
  /** ISO week the run failed, or started when it never finished. */
  week: string;
  failures: number;
  byClass: Record<FailureClass, number>;
}

/** Cancelled runs carry a cancel reason, not a failure. */
const FAILED: ReadonlySet<WorkflowRun["status"]> = new Set(["failed", "recovery_required"]);

const emptyClasses = (): Record<FailureClass, number> => Object.fromEntries(FAILURE_CLASSES.map((cls) => [cls, 0])) as Record<FailureClass, number>;

/** Per repo and ISO week: failed runs counted by failure class; legacy rows without a prefix are classified by their text. */
export function failureStats(runs: readonly WorkflowRun[], range: Parameters<typeof inRange>[1] = {}): FailureRow[] {
  const rows = new Map<string, FailureRow>();
  for (const run of runs) {
    const repo = run.params.repo?.toLowerCase();
    if (!repo || run.error === null || !FAILED.has(run.status)) continue;
    const at = Date.parse(run.completedAt ?? run.startedAt);
    if (!inRange(at, range)) continue;
    const week = isoWeek(at);
    const row = rows.get(`${repo} ${week}`) ?? { repo, week, failures: 0, byClass: emptyClasses() };
    rows.set(`${repo} ${week}`, row);
    row.failures++;
    row.byClass[failureClassOf(run.error)]++;
  }
  return [...rows.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.week.localeCompare(b.week));
}

export function formatFailures(rows: readonly FailureRow[]): string[] {
  const lines = rows.map((row) => {
    const classes = FAILURE_CLASSES.filter((cls) => row.byClass[cls] > 0).map((cls) => `  ${cls} ${row.byClass[cls]}`);
    return `${row.repo}  ${row.week}  failed ${row.failures}${classes.join("")}`;
  });
  return lines.length === 0 ? [] : ["", "failures by class:", ...lines];
}
