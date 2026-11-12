import type { ScorecardRun } from "@titan-design/session-analytics";

/** The step families that wait for an implementer's next head, one per fix round. */
const FIX_ROUND_FAMILIES: ReadonlySet<string> = new Set(["await-new-head", "sh-await-new-head"]);

export interface RunSteps {
  startedAt: string;
  /** Completed steps by family, in completion order. */
  steps: readonly { family: string; completedAt: string }[];
}

/** The time spans of the run's completed fix rounds: from the previous step's completion (or the run's start) to this one. */
function fixRoundSpans(run: RunSteps): [string, string][] {
  const spans: [string, string][] = [];
  let cursor = run.startedAt;
  for (const step of run.steps) {
    if (FIX_ROUND_FAMILIES.has(step.family)) spans.push([cursor, step.completedAt]);
    cursor = step.completedAt;
  }
  return spans;
}

/**
 * Lineage successors that are not already a counted fix round. A successor that joined while an await-new-head step
 * was waiting is the same round that step records, so it is fed once, through the step.
 */
function standaloneSuccessors(run: RunSteps, successorAts: readonly string[]): number {
  const spans = fixRoundSpans(run);
  return successorAts.filter((at) => !spans.some(([from, to]) => at > from && at <= to)).length;
}

export function scorecardRun(runId: string, run: RunSteps, successorAts: readonly string[], reviewRounds: number): ScorecardRun {
  return { runId, stepIds: run.steps.map((s) => s.family), reviewRounds, successors: standaloneSuccessors(run, successorAts) };
}
