import type { RepoSlug } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { step, type LandOutcome } from "../workflows/land.js";
import type { ObservedPr } from "./observe.js";
import type { Verdict } from "./phases.js";
import { FAILED_ROUND_WORDS, MAX_FAILED_ROUNDS, MAX_THROTTLED_ROUNDS, fixFirstEscalation, nextCloserStreak, roundKind, type CloserStreak, type Escalated, type ReviewOutcome, type Route } from "./route-table.js";
import { fixFirstEntry, type FixFirstTrail } from "./fix-first-trail.js";
import { FIX_FIRST_STEP, fixFirstCount } from "./wake-brief.js";

export interface Routed {
  headSha: string;
  verdict: Verdict;
  observed: ObservedPr;
  outcome: ReviewOutcome;
  route: Route;
}

/** The run's round counters `countRound` advances; its FIX_FIRST count is the run's recorded `FIX_FIRST_STEP`s. */
interface RoundCounts extends FixFirstTrail {
  ctx: WorkflowContext;
  target: { repo: RepoSlug; pr: number };
  failedRounds: number;
  throttledRounds: number;
  closer: CloserStreak;
}

const FixFirstRecord = z.looseObject({ fixFirst: z.number().int().positive() });

/** Records a FIX_FIRST at its round, before any hold or wake, so a held or unwoken FIX_FIRST counts as surely as a woken one. */
export async function recordFixFirst(ctx: WorkflowContext, at: { repo: RepoSlug; pr: number; headSha: string }): Promise<number> {
  return (await step(ctx, FIX_FIRST_STEP, { ...at, fixFirst: fixFirstCount(ctx) + 1 }, FixFirstRecord)).fixFirst;
}

/** Counts the round; a conflict's own escalation is `onConflict`'s, so a stuck conflict only adds to the count here. */
export async function countRound(run: RoundCounts, routed: Routed): Promise<Escalated | undefined> {
  const { route, outcome, headSha } = routed;
  const kind = roundKind(route, outcome);
  run.closer = nextCloserStreak(run.closer, kind, routed.verdict, headSha);
  if (kind === "fix-first") {
    run.fixFirstTrail.push(fixFirstEntry(headSha, routed.verdict.kind === "FIX_FIRST" ? routed.verdict.text : ""));
    return fixFirstEscalation(await recordFixFirst(run.ctx, { ...run.target, headSha }), run.closer.streak, headSha);
  }
  // A held MERGE is a verdict waiting on the seat, not a failed review, and its next round starts nobody.
  if (routed.verdict.kind === "none" && routed.verdict.seatHeld !== undefined) return undefined;
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
