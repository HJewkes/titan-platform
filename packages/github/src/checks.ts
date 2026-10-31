import type { CheckRun } from "./port.js";

/**
 * Conclusions that are not red: `isPassing`. Skipped and neutral did not fail but did not run what they cover, so only
 * `success` counts as succeeded (`isSucceeded`), and a required context needs `isSucceeded`. Any other conclusion,
 * including one GitHub adds later, is red.
 */
const PASSING = new Set(["success", "neutral", "skipped"]);

export function isPassingConclusion(conclusion: string | null): boolean {
  return PASSING.has(conclusion ?? "");
}

/**
 * GitHub sometimes leaves a job's status at `in_progress` after it has a conclusion and a completion time. Both set
 * means it finished, so waiting on the status alone would never end.
 */
export function isConcluded(run: CheckRun): boolean {
  return run.status === "completed" || (run.conclusion !== null && run.completedAt !== null);
}

export function isPassing(run: CheckRun): boolean {
  return isConcluded(run) && isPassingConclusion(run.conclusion);
}

export function isSucceeded(run: CheckRun): boolean {
  return isConcluded(run) && run.conclusion === "success";
}

/**
 * One head can carry several runs per name (a superseded run is `cancelled`); only the newest counts. A run with no
 * start that has not completed is newest, so a queued rerun shadows an old result and reads pending. A completed run
 * with no start has no age to compare, so it and any equal start order by id, which GitHub assigns at creation;
 * otherwise the later `startedAt` is newer. The rule is applied per name, not pairwise, because a pairwise mix of id and
 * start order is not transitive and would make the pick depend on the order the API lists runs in.
 */
export function latestPerName(runs: readonly CheckRun[]): CheckRun[] {
  const byName = new Map<string, CheckRun[]>();
  for (const run of runs) byName.set(run.name, [...(byName.get(run.name) ?? []), run]);
  return [...byName.values()].map(newest);
}

function newest(runs: readonly CheckRun[]): CheckRun {
  const unstarted = runs.filter(isUnstarted);
  if (unstarted.length > 0) return unstarted.reduce(higherId);
  if (runs.some((run) => run.startedAt === null)) return runs.reduce(higherId);
  return runs.reduce(laterStart);
}

/** Only called once every run has started. */
function laterStart(best: CheckRun, run: CheckRun): CheckRun {
  const [a, b] = [run.startedAt ?? "", best.startedAt ?? ""];
  if (a === b) return higherId(best, run);
  return a > b ? run : best;
}

function higherId(best: CheckRun, run: CheckRun): CheckRun {
  return run.id > best.id ? run : best;
}

function isUnstarted(run: CheckRun): boolean {
  return run.startedAt === null && !isConcluded(run);
}
