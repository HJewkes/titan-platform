import type { CheckRun } from "./port.js";

/** Conclusions a required check may end with and still count as passed. */
const PASSING = new Set(["success", "neutral", "skipped"]);

export interface ChecksVerdict {
  state: "pending" | "passed" | "failed";
  /** Required names with no completed latest run. */
  pending: string[];
  /** Latest runs of required checks that completed without passing. */
  failing: CheckRun[];
}

/** One head can carry several runs per name (a superseded run is `cancelled`); only the newest counts. */
export function latestPerName(runs: readonly CheckRun[]): CheckRun[] {
  const latest = new Map<string, CheckRun>();
  for (const run of runs) {
    const seen = latest.get(run.name);
    if (!seen || isNewer(run, seen)) latest.set(run.name, run);
  }
  return [...latest.values()];
}

function isNewer(run: CheckRun, than: CheckRun): boolean {
  const a = run.startedAt ?? "";
  const b = than.startedAt ?? "";
  return a === b ? run.id > than.id : a > b;
}

/** A required name with no run at all is pending, never passed. */
export function evaluateChecks(required: readonly string[], latestRuns: readonly CheckRun[]): ChecksVerdict {
  const byName = new Map(latestRuns.map((run) => [run.name, run]));
  const pending: string[] = [];
  const failing: CheckRun[] = [];
  for (const name of required) {
    const run = byName.get(name);
    if (!run || run.status !== "completed") pending.push(name);
    else if (!PASSING.has(run.conclusion ?? "")) failing.push(run);
  }
  const state = failing.length > 0 ? "failed" : pending.length > 0 ? "pending" : "passed";
  return { state, pending, failing };
}
