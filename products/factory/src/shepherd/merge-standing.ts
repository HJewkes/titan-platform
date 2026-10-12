import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { refreshMergeEvidence } from "./merge-settle.js";
import type { Verdict } from "./phases.js";
import { mergeEvidenceAt, runPolicyCeiling } from "./policy.js";
import type { ReviewCause } from "./review-cause.js";
import { MergeEvidenceSchema } from "./review-schemas.js";

/** Records that a head whose MERGE stands got its merge evidence read again instead of a fresh reviewer. */
const REVIEW_REFUSED_STEP = "sh-review-refused";
export const REVIEW_REFUSED_STEPS: readonly StepDeclaration[] = [{ id: REVIEW_REFUSED_STEP, kind: "dispatch" }];

export const reviewRefusedRoute = (now: () => number): StepRoute => codeRoute(REVIEW_REFUSED_STEP, now, async (input: { reason: string; cause: ReviewCause }) => input);

const Refused = z.looseObject({ reason: z.string() });

const OwnMerge = z.looseObject({ merge: z.looseObject({ verdict: z.looseObject({ head: z.string() }), carry: z.unknown().optional() }) });

/**
 * True for merge evidence of a MERGE a reviewer gave at `head` itself. A carried MERGE never counts: it stands only while
 * the carry's checks hold, a seat's FIX_FIRST among them, and a seat's `shepherd review` is its way to get Shepherd's own review.
 */
export function ownMergeEvidence(evidence: unknown, head: string): boolean {
  const parsed = OwnMerge.safeParse(evidence);
  return parsed.success && parsed.data.merge.verdict.head === head && parsed.data.merge.carry === undefined;
}

/** A run recorded before this step existed reviewed the head again, so its replay keeps that reviewer. */
function recordedElsewhere(ctx: WorkflowContext, stepId: string): boolean {
  const next = ctx.historyNext();
  return next !== undefined && next !== stepId;
}

/**
 * The MERGE the run already took at `headSha`, with its evidence read again so the merge policy is asked afresh, as a resync
 * that cancelled the head's gate intends. Undefined means review as before: the MERGE was carried, so the carry is checked
 * again, the stored evidence is not whole, or the run's record shows a reviewer here. The same code at the same head reads the same diff, so a second reviewer adds a round and no
 * information (TP-2392).
 */
export async function standingMerge(ctx: WorkflowContext, merged: Verdict, headSha: string, causeOf: () => ReviewCause): Promise<Verdict | undefined> {
  if (merged.kind !== "MERGE") return undefined;
  const evidence = MergeEvidenceSchema.safeParse(merged.evidence).success ? mergeEvidenceAt(headSha, () => merged) : undefined;
  const stepId = `${REVIEW_REFUSED_STEP}:${headSha}`;
  if (evidence?.head !== headSha || !ownMergeEvidence(evidence, headSha) || recordedElsewhere(ctx, stepId)) return undefined;
  await step(ctx, stepId, { reason: "merge-standing", cause: causeOf() }, Refused);
  const reread = await refreshMergeEvidence(ctx, evidence, runPolicyCeiling(ctx.param("policy")).visualPaths);
  return { ...merged, evidence: reread };
}
