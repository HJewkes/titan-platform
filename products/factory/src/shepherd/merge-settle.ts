import type { WorkflowContext } from "@titan-design/workflow";
import { step } from "../workflows/land.js";
import { MERGE_EVIDENCE_STEP, type MergeEvidence, type MergeEvidenceInput } from "./merge-facts.js";
import { MergeEvidenceSchema } from "./review-schemas.js";

/** The evidence step's input rebuilt from its own earlier output at the head, so a re-read takes exactly the facts the review supplied. */
function rereadInput(runId: string, evidence: MergeEvidence, visualPaths: string[] | undefined): MergeEvidenceInput {
  const { record, merge } = evidence;
  const carried = merge.carry && { fromHead: merge.carry.fromHead, head: merge.carry.head, result: { equal: true, headTree: merge.carry.headTree, mergeTree: merge.carry.mergeTree } };
  return {
    runId,
    repo: record.repo,
    pr: record.pr,
    head: evidence.head,
    verdict: { value: "MERGE", head: merge.verdict.head, locator: record.verdictLocator },
    resolver: merge.resolver,
    dispatchedReviewer: merge.dispatchedReviewer,
    seatGrants: merge.seatGrants,
    ...(carried && { carry: carried }),
    ...(visualPaths && { visualPaths }),
  };
}

/** The evidence step again at the same head; the workflow keys a repeated step id by iteration, so a replay reads the recorded answer. */
export function refreshMergeEvidence(ctx: WorkflowContext, evidence: MergeEvidence, visualPaths: string[] | undefined): Promise<unknown> {
  return step(ctx, `${MERGE_EVIDENCE_STEP}:${evidence.head}`, rereadInput(ctx.runId, evidence, visualPaths), MergeEvidenceSchema);
}
