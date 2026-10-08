import type { CheckRun } from "./port.js";

/** Conclusions that are not red. This is not the required-check rule: `headCheckFindings` demands `success`. */
const PASSING = new Set(["success", "neutral", "skipped"]);

export function isPassing(run: CheckRun): boolean {
  return run.status === "completed" && PASSING.has(run.conclusion ?? "");
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
