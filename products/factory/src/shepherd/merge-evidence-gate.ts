import { StepFailedError, type WorkflowContext } from "@titan-design/workflow";
import type { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { evidenceStalledBrief } from "../gate-brief.js";
import { step } from "../workflows/land.js";
import { failureOf } from "./error-class.js";
import { MERGE_EVIDENCE_STEP, type MergeEvidenceInput } from "./merge-facts.js";
import { MergeEvidenceSchema } from "./review-schemas.js";

const MERGE_EVIDENCE_GATE = "sh-merge-evidence-gate";

export const MERGE_EVIDENCE_STEPS: readonly StepDeclaration[] = [
  { id: MERGE_EVIDENCE_STEP, kind: "dispatch" },
  { id: MERGE_EVIDENCE_GATE, kind: "assisted" },
];

/** An empty or cut-off JSON body from GitHub; a 5xx is a different failure and still fails the run. */
const UNPARSEABLE_BODY = /unexpected end of JSON input|unexpected token/i;

/**
 * GitHub still answered an empty or unparseable body after the step's own retries, which is not the run's
 * fault: the run waits on a gate naming the step, and reads the evidence again once it is answered.
 */
export async function evidenceOrGate(ctx: WorkflowContext, head: string, request: MergeEvidenceInput): Promise<z.infer<typeof MergeEvidenceSchema>> {
  for (;;) {
    try {
      return await step(ctx, `${MERGE_EVIDENCE_STEP}:${head}`, request, MergeEvidenceSchema);
    } catch (error) {
      if (!(error instanceof StepFailedError) || error.stepId !== `${MERGE_EVIDENCE_STEP}:${head}` || !UNPARSEABLE_BODY.test(error.reason)) throw error;
      const situation = `Step ${MERGE_EVIDENCE_STEP} could not post the merge-evidence comment at head ${head}: ${failureOf(error)} after its retries. Answer once GitHub is healthy and Shepherd reads the evidence again.`;
      await ctx.assisted(MERGE_EVIDENCE_GATE, `${request.repo}#${request.pr}: ${situation}`, { brief: evidenceStalledBrief({ repo: request.repo, pr: request.pr, headSha: head, situation }) });
    }
  }
}
