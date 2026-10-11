import type { LandOutcome } from "../workflows/land.js";
import type { ObservedPr } from "./observe.js";
import type { Verdict } from "./phases.js";
import { FAILED_ROUND_WORDS, MAX_FAILED_ROUNDS, MAX_THROTTLED_ROUNDS, fixFirstEscalation, nextCloserStreak, roundKind, type CloserStreak, type Escalated, type ReviewOutcome, type Route } from "./route-table.js";

export interface Routed {
  headSha: string;
  verdict: Verdict;
  observed: ObservedPr;
  outcome: ReviewOutcome;
  route: Route;
}

/** The run's round counters `countRound` advances. */
export interface RoundCounts {
  failedRounds: number;
  throttledRounds: number;
  fixFirsts: number;
  closer: CloserStreak;
}

/** Counts the round; a conflict's own escalation is `onConflict`'s, so a stuck conflict only adds to the count here. */
export function countRound(run: RoundCounts, routed: Routed): Escalated | undefined {
  const { route, outcome, headSha } = routed;
  const kind = roundKind(route, outcome);
  run.closer = nextCloserStreak(run.closer, kind, routed.verdict, headSha);
  if (kind === "fix-first") return fixFirstEscalation(++run.fixFirsts, run.closer.streak, headSha);
  if (kind === "throttled" && ++run.throttledRounds <= MAX_THROTTLED_ROUNDS) return undefined;
  if (kind !== "stuck" && kind !== "throttled") return undefined;
  run.failedRounds += 1;
  if (route === "wake-fixer" || run.failedRounds < MAX_FAILED_ROUNDS) return undefined;
  const ended = (routed.verdict.kind === "none" && routed.verdict.reason) || (FAILED_ROUND_WORDS[outcome] ?? outcome);
  return { escalation: "failed-rounds", detail: `the last at ${headSha} ended with ${ended}` };
}

export function endedOutcome({ observed, headSha }: Routed): LandOutcome {
  if (observed.runState === "merged-elsewhere") return { kind: "merged", headSha: observed.headSha, mergeSha: observed.mergeSha };
  if (observed.runState === "closed-elsewhere") return { kind: "stopped", reason: "closed", headSha, detail: "the pull request was closed outside Shepherd" };
  return { kind: "stopped", reason: "not-mergeable", headSha, detail: "the pull request is a draft" };
}
