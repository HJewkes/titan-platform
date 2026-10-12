import type { AgentIdentity } from "@titan-design/authority";
import { isUsageLimit, type AwaitVerdictInput, type OwnerBrief, type ReviewTarget } from "@titan-design/review-panel";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { step } from "../workflows/land.js";
import { accountHeld } from "./account-hold.js";
import { DEFAULT_ACCOUNT } from "./account-limit.js";
import { AWAIT_VERDICT_STEP } from "./await-verdict.js";
import { correctOnce } from "./correct-verdict.js";
import { evidenceOrGate } from "./merge-evidence-gate.js";
import type { MergeEvidenceInput } from "./merge-facts.js";
import type { SeatHeld, Verdict } from "./phases.js";
import { MERGE_ON_GREEN_GRANT, runPolicyCeiling } from "./policy.js";
import { publishReview } from "./publish-review.js";
import { Awaited } from "./review-schemas.js";
import { dispatchedNone } from "./review-stop.js";

/** A timed-out reviewer that has not exited is read once more under this step. */
export const LATE_VERDICT_STEP = "sh-late-verdict";

/** A MERGE at one head, taken or carried, published before its evidence step reads the check; a replay reuses each step's output. */
export async function mergeVerdict(ctx: WorkflowContext, input: Omit<MergeEvidenceInput, "runId">, ownerBrief?: OwnerBrief): Promise<Verdict> {
  await publishReview(ctx, input, { outcome: "MERGE", verdictHead: input.verdict.head, head: input.head, ...(input.carry && { carriedFrom: input.carry.fromHead, carryRule: input.carry.rule ?? "tree-equal" }) });
  const { visualPaths } = effectivePolicy(ctx);
  const request: MergeEvidenceInput = { ...input, runId: ctx.runId, ...(visualPaths && { visualPaths }) };
  const evidence = await evidenceOrGate(ctx, input.head, request);
  return { kind: "MERGE", headSha: input.head, evidence, ...(ownerBrief && { ownerBrief }) };
}

/** The grant is read from the run's own policy param, the ceiling a registration can only narrow. */
const effectivePolicy = (ctx: WorkflowContext) => runPolicyCeiling(ctx.param("policy"));
/** Whether a visual-path gate will open is unknown until the evidence step, so a visual-ceiling run always asks for the brief. */
export const asksOwnerBrief = (ctx: WorkflowContext): boolean => {
  const policy = effectivePolicy(ctx);
  return policy.merge === "owner-gate" || (policy.visualPaths?.length ?? 0) > 0;
};
const seatGrants = (ctx: WorkflowContext): string[] => (effectivePolicy(ctx).merge === "auto" ? [MERGE_ON_GREEN_GRANT] : []);

type ExternalAwaiting = ReviewTarget & { external: string };
export type AwaitedResult = z.infer<typeof Awaited>;

/** The own MERGE a seat WAIT held, as the verdict step recorded it on its `none`. */
const HeldMerge = z.looseObject({ head: z.string(), locator: z.unknown(), reviewer: z.object({ agentId: z.string().min(1), sessionId: z.string().min(1) }) });

function heldMergeOf(result: AwaitedResult): z.infer<typeof HeldMerge> | undefined {
  if (result.kind !== "none") return undefined;
  const read = HeldMerge.safeParse(result.seatHeld);
  return read.success ? read.data : undefined;
}

function seatHeldOf(result: AwaitedResult, dispatchedReviewer: AgentIdentity): SeatHeld | undefined {
  const held = heldMergeOf(result);
  return held && { head: held.head, locator: held.locator, reviewer: held.reviewer, dispatchedReviewer };
}

/** A dispatched reviewer stopped by its account's usage limit holds `account` until the reset; any other result is not a limit. */
function limitHeld(ctx: WorkflowContext, target: ReviewTarget, result: AwaitedResult, dispatchedReviewer: AgentIdentity | undefined, account: string): Promise<Verdict> | undefined {
  if (!dispatchedReviewer || !isUsageLimit(result)) return undefined;
  return accountHeld(ctx, target, { account, notice: String(result.notice), ...(typeof result.resetsAt === "number" && { resetsAt: result.resetsAt }) });
}

/**
 * A dispatched reviewer that missed the wait is read once more, so a late MERGE is a MERGE, not a no-facts gate, and a malformed
 * final message gets one correction turn. A reviewer stopped by its account's usage limit, read on time, late or as the
 * correction's reply, is held on `account` until the reset, never handed to a fresh reviewer. An own MERGE a seat WAIT held
 * has its verdict already, so it is neither read late nor corrected.
 */
export async function takeAwaited(ctx: WorkflowContext, target: ReviewTarget, awaiting: AwaitVerdictInput | ExternalAwaiting, dispatchedReviewer: AgentIdentity | undefined, account: string): Promise<{ held: Verdict } | { awaited: AwaitedResult }> {
  const onTime = await step(ctx, `${AWAIT_VERDICT_STEP}:${target.head}`, awaiting, Awaited);
  const heldOnTime = limitHeld(ctx, target, onTime, dispatchedReviewer, account);
  if (heldOnTime) return { held: await heldOnTime };
  if (heldMergeOf(onTime)) return { awaited: onTime };
  const late = onTime.kind === "none" && dispatchedReviewer ? await step(ctx, `${LATE_VERDICT_STEP}:${target.head}`, awaiting, Awaited) : onTime;
  const correction = { ownerBrief: asksOwnerBrief(ctx), replyStep: `${AWAIT_VERDICT_STEP}:${target.head}:corrected` };
  const awaited = dispatchedReviewer && !("external" in awaiting) && !heldMergeOf(late) ? await correctOnce(ctx, awaiting, late, correction) : late;
  const heldLate = limitHeld(ctx, target, awaited, dispatchedReviewer, account);
  return heldLate ? { held: await heldLate } : { awaited };
}

/** An external reviewer is both the dispatched reviewer and the resolver, because Shepherd started nobody else. */
export async function takeVerdict(ctx: WorkflowContext, target: ReviewTarget, awaiting: AwaitVerdictInput | ExternalAwaiting, dispatchedReviewer: AgentIdentity | undefined, account = DEFAULT_ACCOUNT): Promise<Verdict> {
  const taken = await takeAwaited(ctx, target, awaiting, dispatchedReviewer, account);
  return "held" in taken ? taken.held : verdictOf(ctx, target, awaiting, dispatchedReviewer, taken.awaited);
}

export async function verdictOf(ctx: WorkflowContext, target: ReviewTarget, awaiting: AwaitVerdictInput | ExternalAwaiting, dispatchedReviewer: AgentIdentity | undefined, awaited: AwaitedResult): Promise<Verdict> {
  const seatHeld = dispatchedReviewer && seatHeldOf(awaited, dispatchedReviewer);
  if (seatHeld) return { kind: "none", cause: "external-hold", ...(typeof awaited.reason === "string" && { reason: awaited.reason }), seatHeld };
  if (awaited.kind !== "verdict") return dispatchedReviewer && !("external" in awaiting) ? dispatchedNone(ctx, target.head, awaiting.startedAt ?? awaiting.dispatchedAt, awaited.reason) : { kind: "none", cause: "external-hold", ...(typeof awaited.reason === "string" && { reason: awaited.reason }) };
  if (awaited.verdict === "FIX_FIRST") return { kind: "FIX_FIRST", headSha: target.head, text: awaited.text ?? "", ...(awaited.closer === "yes" || awaited.closer === "no" ? { closer: awaited.closer } : {}) };
  const verdict = { value: "MERGE" as const, head: awaited.head, locator: awaited.locator };
  return mergeVerdict(ctx, { ...target, verdict, resolver: awaited.reviewer, dispatchedReviewer: dispatchedReviewer ?? awaited.reviewer, seatGrants: seatGrants(ctx) }, awaited.ownerBrief ?? undefined);
}
