import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { errorClass } from "./error-class.js";
import { evidenceComment, evidenceMarker } from "./evidence-comment.js";
import type { EvidenceRecord } from "./evidence-record.js";

const EVIDENCE_MERGED_STEP = "sh-evidence-merged";
export const EVIDENCE_MERGED_STEPS: readonly StepDeclaration[] = [{ id: EVIDENCE_MERGED_STEP, kind: "dispatch" }];

interface EvidenceMergedInput {
  repo: RepoSlug;
  pr: number;
  headSha: string;
  record: EvidenceRecord;
}

const EvidenceMergedResult = z.looseObject({ edited: z.boolean(), reason: z.string().optional() });
type EvidenceMergedResult = z.infer<typeof EvidenceMergedResult>;

/**
 * Best-effort: GitHub is asked again whether this head merged, because the comment is the only place the word is written
 * and it must stay true. Any doubt or port error leaves the comment as it is and never fails the run.
 */
export async function markMerged(port: GitHubPort, input: EvidenceMergedInput): Promise<EvidenceMergedResult> {
  if (input.record.head !== input.headSha) return { edited: false, reason: "record-head-differs" };
  try {
    const pr = await port.getPr(input.repo, input.pr);
    if (!pr.merged || pr.mergedAt === null) return { edited: false, reason: "not-merged" };
    if (pr.headSha !== input.headSha) return { edited: false, reason: "head-differs" };
    await port.upsertComment(input.repo, input.pr, evidenceMarker(input.headSha), evidenceComment(input.record, { mergeSha: pr.mergeSha }));
    return { edited: true };
  } catch (error) {
    return { edited: false, reason: errorClass(error) };
  }
}

export function evidenceMergedRoute(deps: { port: GitHubPort; now: () => number }): StepRoute {
  return codeRoute(EVIDENCE_MERGED_STEP, deps.now, (input: EvidenceMergedInput) => markMerged(deps.port, input));
}

/** A run recorded before this step existed has another step next in its history, and replays without it. */
export async function recordEvidenceMerged(ctx: WorkflowContext, target: { repo: RepoSlug; pr: number }, headSha: string, record: EvidenceRecord | undefined): Promise<void> {
  if (record === undefined) return;
  const next = ctx.historyNext();
  if (next !== undefined && !stepIdMatches(EVIDENCE_MERGED_STEP, next)) return;
  await step(ctx, EVIDENCE_MERGED_STEP, { ...target, headSha, record }, EvidenceMergedResult);
}
