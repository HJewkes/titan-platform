import type { MarkerRow } from "./marker-store.js";
import type { Verdict } from "./validity.js";

/**
 * What one entry did with the run's record. `recorded` is the memo keys the run held when the entry began, in recording
 * order. `reached` is how far into them the entry got (exclusive): a memo hit at index i reaches i + 1, and a live call
 * reaches the end, since strict replay lets a call go live only once the record is read.
 */
export interface EntryLog {
  readonly runId: string;
  readonly recorded: readonly string[];
  readonly visited: Set<string>;
  reached: number;
  failClosed: boolean;
}

/** Marks a call site as visited: a live call or a memo hit with its memo key, or a step a `not-after` rule skipped without one. */
export function visit(log: EntryLog, callSite: string, memoKey?: string): void {
  log.visited.add(callSite);
  if (memoKey === undefined) return;
  const index = log.recorded.indexOf(memoKey);
  log.reached = Math.max(log.reached, index < 0 ? log.recorded.length : index + 1);
}

/**
 * The valid markers this run wrote at a call site the entry passed without visiting (a skipped call site). A site after
 * where the entry stopped is never an orphan, so an early return reports none.
 */
export function findOrphans(log: EntryLog, markers: readonly MarkerRow[], requirementSet: ReadonlySet<string>, verdictOf: (marker: MarkerRow) => Verdict["status"]): MarkerRow[] {
  return markers.filter((marker) => {
    if (marker.runId !== log.runId || marker.memoKey === null) return false;
    const index = log.recorded.indexOf(marker.memoKey);
    return index >= 0 && log.reached > index && !log.visited.has(marker.callSite) && requirementSet.has(marker.fact) && verdictOf(marker) === "valid";
  });
}
