import type { StepResult } from "@titan-design/workflow";
import { CI_WAIT_ATTEMPTS } from "../workflows/land-budget.js";
import { EVENT_KINDS, SHEPHERD_ACTOR } from "./events.js";
import type { TimelineEntry } from "./view.js";

/** The stored event kinds, plus `ci-timeout`, which is read from a timed-out `ci-wait` record rather than stored. */
export const TIMELINE_EVENT_KINDS = [...EVENT_KINDS, "ci-timeout"] as const;

export function ciTimeoutEntry(result: StepResult, headSha: string, timedOut: { afterMs: number; reason: string }): TimelineEntry {
  const reason = `${result.stepId} timed out after ${timedOut.afterMs} ms, ${timedOut.reason}`;
  return { kind: "event", event: "ci-timeout", reason, actor: SHEPHERD_ACTOR, at: result.completedAt, headSha };
}

/** Each timed-out window names its attempt, counted as land counts them: a ci read that did not time out starts over. */
export function numberedTimeouts(entries: TimelineEntry[]): TimelineEntry[] {
  let attempt = 0;
  return entries.map((entry) => {
    if (entry.kind === "ci") attempt = 0;
    if (entry.kind !== "event" || entry.event !== "ci-timeout") return entry;
    attempt += 1;
    const next = attempt < CI_WAIT_ATTEMPTS ? "waiting again" : "attempts spent, the run fails";
    return { ...entry, reason: `attempt ${attempt} of ${CI_WAIT_ATTEMPTS}, ${next}: ${entry.reason}` };
  });
}
