import type { RepoSlug } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { GATE_DEMOTIONS, recordAutoPass, type GateDemotions } from "./auto-pass.js";
import { noticeHeldSeat } from "./gate-route.js";
import { awaitNewHead } from "./gates.js";
import { LeaveLand } from "./leave-land.js";
import { requestDiagnosis } from "./no-verdict-diagnosis.js";
import { freshNoVerdictState, noteReviewerStep, type NoVerdictState } from "./no-verdict-round.js";
import { tapped } from "./review-cause.js";
import type { Verdict } from "./phases.js";
import { REVIEW_INTENT_STEP } from "./review.js";
import { SEAT_HELD_ROUNDS_WORDS, type Escalated } from "./route-table.js";
import { stepIdMatches } from "../definition.js";

/** The run state D7 adds: what each counted round failed on, and whether the fallback reviewer went. */
export interface FailedRoundsState extends NoVerdictState {
  /** The outcome of each round `failedRounds` counted; a conflict counts as `conflict`. */
  failedOutcomes: string[];
  failedRounds: number;
  fallbackReviewed: boolean;
  /** The account the last review intent billed, named in the ops notice; absent until a review is intended. */
  reviewerAccount?: string;
}

/** What the D7 demotion reads and moves on a shepherd run. */
export interface FailedRoundsRun extends FailedRoundsState {
  ctx: WorkflowContext;
  target: { repo: RepoSlug; pr: number };
  state: { waits: number };
  reviews: Map<string, Verdict>;
  fresh: Set<string>;
  escalations: Map<string, Escalated>;
  task?: string;
}

/**
 * `review-again` sends a fresh reviewer to the same head, `diagnose` spawns a planner over the silent reviewers and waits,
 * `notice` tells ops or the seat and waits, `gate` asks the owner.
 */
type FailedRoundsRoute =
  | { route: "review-again" }
  | { route: "diagnose"; escalated: Escalated }
  | { route: "notice"; to: "review-infra" | "seat-held"; escalated: Escalated }
  | { route: "gate"; escalated: Escalated };

/**
 * D7 (TP-3697): a failed-rounds escalation whose every counted round failed on infrastructure sends one fresh reviewer
 * before anyone else. D7 never merges: a MERGE still has to stand through the normal review path. A failed fallback is
 * a reviewer infrastructure defect for ops, and a seat-held run-out is the seat's (TP-3734); only a round that failed on
 * more than infrastructure keeps the owner gate. Rounds where no adversary ever returned a verdict get no fourth blind review:
 * a planner works out why the reviews fail (TP-3796).
 */
export async function demoteFailedRounds(run: FailedRoundsRun, headSha: string, escalated: Escalated, demotions: GateDemotions = GATE_DEMOTIONS): Promise<FailedRoundsRoute> {
  if (escalated.escalation !== "failed-rounds") return { route: "gate", escalated };
  if (escalated.words === SEAT_HELD_ROUNDS_WORDS) return demotions.failedFallback ? { route: "notice", to: "seat-held", escalated } : { route: "gate", escalated };
  if (demotions.neverVerdictDiagnosis && escalated.neverVerdict === true && escalated.words === undefined) return { route: "diagnose", escalated };
  if (!demotions.failedRounds || escalated.words !== undefined || !escalated.infraOnly) return { route: "gate", escalated };
  if (run.fallbackReviewed) {
    const failedToo = { ...escalated, detail: `${escalated.detail}; the fallback fresh reviewer failed too` };
    return demotions.failedFallback ? { route: "notice", to: "review-infra", escalated: failedToo } : { route: "gate", escalated: failedToo };
  }
  run.fallbackReviewed = true;
  run.reviews.delete(headSha);
  run.fresh.add(headSha);
  const detail = `${escalated.detail}; every round failed on infrastructure, so a fresh reviewer goes before the owner.`;
  await recordAutoPass(run.ctx, { ...run.target, rule: "D7/fallback-reviewer", headSha, detail, evidence: [`head ${headSha}`, `failed rounds: ${run.failedOutcomes.join(", ")}`] });
  return { route: "review-again" };
}

/** A conflict is a stuck round, and never an infrastructure failure. */
export function countConflictRound(run: FailedRoundsState): void {
  run.failedRounds += 1;
  run.failedOutcomes.push("conflict");
}

/** The failed-rounds state of a run, or of a new head whose rounds count afresh. */
export const freshFailedRounds = (): Omit<FailedRoundsState, "reviewerAccount"> => ({ failedRounds: 0, failedOutcomes: [], fallbackReviewed: false, ...freshNoVerdictState() });

const Billed = z.looseObject({ kind: z.literal("intent"), account: z.string().optional() });

/** Taps the review's recorded steps, so the run knows which account its last reviewer billed; a replay rebuilds it. */
export function noteReviewerAccount(run: FailedRoundsState, stepId: string, result: unknown): void {
  const billed = stepIdMatches(REVIEW_INTENT_STEP, stepId) ? Billed.safeParse(result) : undefined;
  if (billed?.success) run.reviewerAccount = billed.data.account ?? "the default account";
}

/** The run's context for one review, tapped for the account it bills and the reviewers it dispatches; the round starts with none. */
export function tappedReview(run: FailedRoundsState & { ctx: WorkflowContext }): WorkflowContext {
  run.roundReviewers = [];
  return tapped(run.ctx, (stepId, result) => {
    noteReviewerAccount(run, stepId, result);
    noteReviewerStep(run, stepId, result);
  });
}

type Notice = Extract<FailedRoundsRoute, { route: "notice" }>;

const NOTICE_RULE = { "review-infra": "D7/ops-notice", "seat-held": "D7/seat-notice" } as const;

/** The sent result of the notice, or undefined when this head's notice already went. */
async function tellFailedRounds(run: FailedRoundsRun, headSha: string, notice: Notice): Promise<{ sent: boolean; detail: string } | undefined> {
  const outcomes = run.failedOutcomes.join(", ") || "none counted";
  const why = `${notice.escalated.detail}; failed rounds: ${outcomes}; reviewer account: ${run.reviewerAccount ?? "unknown"}`;
  const evidence = [`head ${headSha}`, `failed rounds: ${outcomes}`];
  await recordAutoPass(run.ctx, { ...run.target, rule: NOTICE_RULE[notice.to], headSha, detail: notice.escalated.detail, evidence });
  return noticeHeldSeat(run, JSON.stringify([notice.to, headSha]), { headSha, why, gate: notice.to });
}

/**
 * Ops or the seat hears, and the run waits for a new head, whose rounds count afresh. Only a notice that could not go
 * out asks the owner, naming why, so the PR never waits on nobody.
 */
async function noticeOrGate(run: FailedRoundsRun, headSha: string, notice: Notice): Promise<boolean> {
  const told = await tellFailedRounds(run, headSha, notice);
  if (told?.sent === false) {
    run.escalations.set(headSha, { ...notice.escalated, detail: `${notice.escalated.detail} (${told.detail})` });
    return true;
  }
  return awaitNewHeadAfresh(run, headSha);
}

/** The run waits for a new head, whose rounds count afresh. */
async function awaitNewHeadAfresh(run: FailedRoundsRun, headSha: string): Promise<never> {
  Object.assign(run, freshFailedRounds());
  throw new LeaveLand(await awaitNewHead(run, headSha));
}

/**
 * A planner reads the silent reviewers' sessions and the serve log, and the run waits for a new head. A planner that could
 * not start leaves the ops notice, or the owner gate where that notice is reverted, so the PR never waits on nobody.
 */
async function diagnoseOrNotice(run: FailedRoundsRun, headSha: string, escalated: Escalated): Promise<boolean> {
  const detail = `${escalated.detail}; no adversary verdict in any round, so a planner diagnoses why instead of a fourth review or the owner.`;
  const evidence = [`head ${headSha}`, `failed rounds: ${run.failedOutcomes.join(", ")}`, `reviewers with no verdict: ${run.failedReviewers.filter((reviewer) => reviewer.verdict !== true).length}`];
  await recordAutoPass(run.ctx, { ...run.target, rule: "D7/no-verdict-diagnosis", headSha, detail, evidence });
  const diagnosis = await requestDiagnosis(run, headSha);
  if (diagnosis.spawned) return awaitNewHeadAfresh(run, headSha);
  const unspawned = { ...escalated, detail: `${escalated.detail}; the diagnosis planner did not start: ${diagnosis.reason ?? "no reason given"}` };
  if (GATE_DEMOTIONS.failedFallback) return noticeOrGate(run, headSha, { route: "notice", to: "review-infra", escalated: unspawned });
  run.escalations.set(headSha, unspawned);
  return true;
}

/** True goes on to the merge decision, where the owner gate opens; false reviews the head again with the D7 fallback reviewer. */
export async function onEscalated(run: FailedRoundsRun, headSha: string, escalated: Escalated): Promise<boolean> {
  const demoted = await demoteFailedRounds(run, headSha, escalated);
  if (demoted.route === "review-again") return false;
  if (demoted.route === "diagnose") return diagnoseOrNotice(run, headSha, demoted.escalated);
  if (demoted.route === "notice") return noticeOrGate(run, headSha, demoted);
  run.escalations.set(headSha, demoted.escalated);
  return true;
}
