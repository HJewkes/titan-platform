import type { AgentIdentity } from "@titan-design/authority";
import type { AwaitVerdictInput, ReviewTarget } from "@titan-design/review-panel";
import type { WorkflowContext } from "@titan-design/workflow";
import type { z } from "zod";
import { step } from "../workflows/land.js";
import { DEFAULT_ACCOUNT } from "./account-limit.js";
import { convergenceFields } from "./fix-first-trail.js";
import { workflowCiFieldOf, type readFixProofAt } from "./fix-proof.js";
import { withReviewerProfile } from "./g10-release.js";
import { notReviewed } from "./not-reviewed.js";
import type { ReviewRequest, Verdict } from "./phases.js";
import { withoutPlan } from "./review-panel-plan.js";
import { panelOn, panelReview, type MemberBase } from "./review-panel-step.js";
import { Dispatched, type Intended } from "./review-schemas.js";
import { scopedRereviewOf } from "./review-scope-round.js";
import { REVIEW_STEP } from "./review-steps.js";
import { scopeRoundOf } from "./scope-check-round.js";
import { asksOwnerBrief, takeVerdict, type ProofStanding } from "./take-verdict.js";
import { fixFirstCount } from "./wake-brief.js";

type IntentRecord = Extract<z.infer<typeof Intended>, { kind: "intent" }>;

export interface RoundStart {
  target: ReviewTarget;
  proof: Awaited<ReturnType<typeof readFixProofAt>>;
  standing: ProofStanding;
  intent: IntentRecord;
}

type Round = { dispatched: z.infer<typeof Dispatched>; verdict: Verdict };

/** The proof fields every member's brief carries: the raw line, why it proves nothing, and the head an owner waived it at. */
function proofBase(ctx: WorkflowContext, { target, proof, standing }: RoundStart, fixFirsts: number): MemberBase {
  const unverified = standing.unverified && { fixProofUnverified: standing.unverified };
  const waived = standing.waivedAt !== undefined && { fixProofWaivedAt: standing.waivedAt };
  return { ...target, runId: ctx.runId, ...(fixFirsts > 0 && { fixFirsts }), ...(proof.kind === "result" && { fixProof: proof.line }), ...unverified, ...waived, ...workflowCiFieldOf(proof) };
}

function awaitingOf(target: ReviewTarget, dispatched: Extract<Round["dispatched"], { kind: "dispatched" }>): AwaitVerdictInput & { reviewerProfile?: string } {
  return {
    ...target,
    reviewerAgentId: dispatched.agentId,
    reviewerSessionId: dispatched.sessionId,
    dispatchedAt: dispatched.at,
    ...(dispatched.startedAt !== undefined && { startedAt: dispatched.startedAt }),
    ...(dispatched.profile !== undefined && { reviewerProfile: dispatched.profile }),
  };
}

/** Starts the intent's reviewer and takes its verdict; the dispatch record goes back beside the verdict for the round's shadow. */
export async function dispatchedRound(ctx: WorkflowContext, request: ReviewRequest, start: RoundStart): Promise<Round> {
  const { target, proof, standing, intent } = start;
  const fixFirsts = fixFirstCount(ctx);
  const base = proofBase(ctx, start, fixFirsts);
  const { scopedRereview } = await scopedRereviewOf(ctx, request, intent);
  const { fixProof, fixProofUnverified, fixProofWaivedAt } = base;
  const waived = fixProofWaivedAt !== undefined && { fixProofWaivedAt };
  const proofFields = { ...(fixProof !== undefined && { fixProof }), ...(fixProofUnverified && { fixProofUnverified }), ...waived, ...workflowCiFieldOf(proof) };
  const rounds = { ...(fixFirsts > 0 && { fixFirsts }), ...(asksOwnerBrief(ctx) && { ownerBrief: true }) };
  const asked = { ...rounds, ...proofFields, ...convergenceFields(request.convergence), ...(scopedRereview && { scopedRereview }) };
  const dispatched = await step(ctx, `${REVIEW_STEP}:${target.head}`, { ...target, runId: ctx.runId, intent: withoutPlan(intent), ...asked }, Dispatched);
  if (dispatched.kind !== "dispatched") return { dispatched, verdict: await notReviewed(ctx, target, dispatched) };
  const dispatchedReviewer: AgentIdentity = { agentId: dispatched.agentId, sessionId: dispatched.sessionId };
  const awaiting = awaitingOf(target, dispatched);
  const account = typeof intent.account === "string" ? intent.account : DEFAULT_ACCOUNT;
  const scope = scopeRoundOf(intent, scopedRereview);
  const reviewed = panelOn(intent)
    ? await panelReview(ctx, intent, base, awaiting, dispatchedReviewer, account, standing, scope)
    : await takeVerdict(ctx, target, awaiting, dispatchedReviewer, account, standing, scope);
  return { dispatched, verdict: withReviewerProfile(reviewed, dispatched.profile) };
}
