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

export function isPassing(run: CheckRun): boolean {
  return run.status === "completed" && isPassingConclusion(run.conclusion);
}

export function isSucceeded(run: CheckRun): boolean {
  return run.status === "completed" && run.conclusion === "success";
}

/**
 * One head can carry several runs per name (a superseded run is `cancelled`); only the newest counts. Newest is the
 * latest `startedAt`; a run not yet started (null) is newer than any started one, so a queued rerun shadows an old
 * result and reads pending; a tie goes to the higher id, which GitHub assigns later.
 */
export function latestPerName(runs: readonly CheckRun[]): CheckRun[] {
  const latest = new Map<string, CheckRun>();
  for (const run of runs) {
    const seen = latest.get(run.name);
    if (!seen || isNewer(run, seen)) latest.set(run.name, run);
  }
  return [...latest.values()];
}

function isNewer(run: CheckRun, than: CheckRun): boolean {
  if (run.startedAt === than.startedAt) return run.id > than.id;
  if (run.startedAt === null) return true;
  if (than.startedAt === null) return false;
  return run.startedAt > than.startedAt;
}
