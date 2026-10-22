import type { RepoSlug } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { step, type LandOutcome } from "../workflows/land.js";
import type { ObservedPr } from "./observe.js";
import type { Verdict } from "./phases.js";
import { FAILED_ROUND_WORDS, INFRA_FAILURES, MAX_FAILED_ROUNDS, MAX_SEAT_HELD_ROUNDS, MAX_THROTTLED_ROUNDS, SEAT_HELD_ROUNDS_WORDS, fixFirstEscalation, nextCloserStreak, roundKind, type CloserStreak, type Escalated, type ReviewOutcome, type Route } from "./route-table.js";
import { fixFirstEntry, type FixFirstTrail } from "./fix-first-trail.js";
import { onEscalated, type FailedRoundsRun } from "./failed-rounds-demotion.js";
import { onFixFirstEscalated, type FixFirstDemotionRun } from "./fix-first-demotion.js";
import { countFailedReviewers, repeatsLastPanel, type NoVerdictState } from "./no-verdict-round.js";
import { DIAGNOSIS_RULE, autoPassStepId } from "./auto-pass.js";
import { FIX_FIRST_STEP, fixFirstCount } from "./wake-brief.js";

export interface Routed {
  headSha: string;
  verdict: Verdict;
  observed: ObservedPr;
  outcome: ReviewOutcome;
  route: Route;
}

/** The run's round counters `countRound` advances; its FIX_FIRST count is the run's recorded `FIX_FIRST_STEP`s. */
interface RoundCounts extends FixFirstTrail, NoVerdictState {
  ctx: WorkflowContext;
  target: { repo: RepoSlug; pr: number };
  failedRounds: number;
  /** The outcome of each round `failedRounds` counted, so a failed-rounds escalation knows whether only infrastructure failed. */
  failedOutcomes: string[];
  throttledRounds: number;
  closer: CloserStreak;
  /** Rounds at each head that ended with Shepherd's own MERGE held by the seat. */
  seatHeldRounds: Map<string, number>;
}

const FixFirstRecord = z.looseObject({ fixFirst: z.number().int().positive() });

/** Records a FIX_FIRST at its round, before any hold or wake, so a held or unwoken FIX_FIRST counts as surely as a woken one. */
export async function recordFixFirst(ctx: WorkflowContext, at: { repo: RepoSlug; pr: number; headSha: string }): Promise<number> {
  return (await step(ctx, FIX_FIRST_STEP, { ...at, fixFirst: fixFirstCount(ctx) + 1 }, FixFirstRecord)).fixFirst;
}

/**
 * A NO_REPRO is no reviewer's FIX_FIRST, so it spends only the fix-proof wake cap (TP-3900). A record from before that
 * counted it as one, and its replay reads that record so the run does not diverge.
 */
function recordedNoReproAsFixFirst(ctx: WorkflowContext): boolean {
  return ctx.historyNext() === FIX_FIRST_STEP;
}

/** Counts the round; a conflict's own escalation is `onConflict`'s, so a stuck conflict only adds to the count here. */
export async function countRound(run: RoundCounts, routed: Routed): Promise<Escalated | undefined> {
  const { route, outcome, headSha } = routed;
  const kind = roundKind(route, outcome);
  run.closer = nextCloserStreak(run.closer, kind, routed.verdict, headSha);
  if (kind === "fix-first" && routed.verdict.kind === "NO_REPRO" && !recordedNoReproAsFixFirst(run.ctx)) return undefined;
  if (kind === "fix-first") {
    run.fixFirstTrail.push(routed.verdict.kind === "FIX_FIRST" ? fixFirstEntry(headSha, routed.verdict.text) : { headSha, text: "", noRepro: true });
    return fixFirstEscalation(await recordFixFirst(run.ctx, { ...run.target, headSha }), run.closer.streak, headSha);
  }
  // A held MERGE is a verdict waiting on the seat, not a failed review, and its next round starts nobody.
  if (routed.verdict.kind === "none" && routed.verdict.seatHeld !== undefined) return seatHoldRunOut(run.seatHeldRounds, headSha, routed.verdict.reason);
  if (kind === "throttled" && ++run.throttledRounds <= MAX_THROTTLED_ROUNDS) return undefined;
  if (kind !== "stuck" && kind !== "throttled") return undefined;
  run.failedRounds += 1;
  run.failedOutcomes.push(route === "wake-fixer" ? `${outcome} at a conflict` : outcome);
  const repeated = outcome === "no-verdict" && route === "fresh-reviewer" && repeatsLastPanel(run, headSha) && !recordedAnotherReview(run.ctx, headSha);
  countFailedReviewers(run, headSha);
  if (repeated) return repeatedNoVerdictEscalation(routed);
  if (route === "wake-fixer" || run.failedRounds < MAX_FAILED_ROUNDS) return undefined;
  return failedRoundsEscalation(run, routed);
}

/** A record from before TP-3910 reviewed a repeated head again rather than diagnosing it, and its replay does too. */
function recordedAnotherReview(ctx: WorkflowContext, headSha: string): boolean {
  const next = ctx.historyNext();
  return next !== undefined && next !== autoPassStepId(DIAGNOSIS_RULE, headSha);
}

function lastRoundDetail({ verdict, outcome, headSha }: Routed): string {
  const ended = (verdict.kind === "none" && verdict.reason) || (FAILED_ROUND_WORDS[outcome] ?? outcome);
  return `the last at ${headSha} ended with ${ended}`;
}

function repeatedNoVerdictEscalation(routed: Routed): Escalated {
  return { escalation: "failed-rounds", detail: lastRoundDetail(routed), infraOnly: true, repeatedNoVerdict: true };
}

function failedRoundsEscalation(run: RoundCounts, routed: Routed): Escalated {
  const infra = run.failedOutcomes.every((failed) => INFRA_FAILURES.has(failed));
  const never = infra && !run.adversaryHeard;
  return { escalation: "failed-rounds", detail: lastRoundDetail(routed), ...(infra && { infraOnly: true as const }), ...(never && { neverVerdict: true as const }) };
}

/** D8's convergence review answers a runaway first; any other escalation, or one D8 leaves, goes on to D7 and then the owner gate. */
export async function routeEscalation(run: FailedRoundsRun & FixFirstDemotionRun, headSha: string, escalated: Escalated): Promise<boolean> {
  return (await onFixFirstEscalated(run, headSha, escalated)) ?? onEscalated(run, headSha, escalated);
}

/** A seat that never settles, say one whose reviewer exited on a WAIT, still reaches the owner's failed-rounds gate. */
function seatHoldRunOut(held: Map<string, number>, headSha: string, reason: string | undefined): Escalated | undefined {
  const rounds = (held.get(headSha) ?? 0) + 1;
  held.set(headSha, rounds);
  if (rounds < MAX_SEAT_HELD_ROUNDS) return undefined;
  return { escalation: "failed-rounds", words: SEAT_HELD_ROUNDS_WORDS, detail: `at ${headSha}, the last with ${reason ?? "no reason given"}` };
}

export function endedOutcome({ observed, headSha }: Routed): LandOutcome {
  if (observed.runState === "merged-elsewhere") return { kind: "merged", headSha: observed.headSha, mergeSha: observed.mergeSha };
  if (observed.runState === "closed-elsewhere") return { kind: "stopped", reason: "closed", headSha, detail: "the pull request was closed outside Shepherd" };
  return { kind: "stopped", reason: "not-mergeable", headSha, detail: "the pull request is a draft" };
}
