import type { WorkflowContext } from "@titan-design/workflow";
import type { z } from "zod";
import { fixProofStepId, readFixProofAt, type FixProofReadSchema } from "./fix-proof.js";
import { proofUnverifiedOf } from "./grant-withheld.js";
import type { MergeEvidence } from "./merge-facts.js";
import { proofStandingAt } from "./proof-waiver.js";

type EvidenceAt = (headSha: string) => MergeEvidence | undefined;

/** A read on the decided base: `unproven` says why it does not prove the head, and is absent when it does. */
type BaseRead = { unproven?: string };

/**
 * A MERGE whose fix-proof judged another base than the one being decided, as a stacked PR's refusal on its parent did before
 * GitHub retargeted it with the same head (TP-4259). Only a read on the decided base, through the review's own read and
 * judge, proves the head there.
 */
export interface ProofOnBase {
  /** Why an allow on `base` gates, or undefined when the proof judged `base` or a read on it stands. */
  unproven: (headSha: string, base: string) => string | undefined;
  /** Reads the head's fix-proof on `base` when its proof judged another, so the next decision judges that read; no base reads nothing. */
  reread: (ctx: WorkflowContext, headSha: string, base: string | undefined) => Promise<void>;
}

/**
 * `current` is the evidence as last re-read, which keeps the review's `proofBase`; a record without one, from a read that named
 * no base, falls back to the base the review itself read its evidence on (`reviewed`), never a later re-read's.
 */
export function proofOnBase(current: EvidenceAt, reviewed: EvidenceAt): ProofOnBase {
  const reads = new Map<string, BaseRead>();
  const judgedElsewhere = (headSha: string, base: string): string | undefined => {
    const judged = current(headSha)?.record.proofBase ?? reviewed(headSha)?.record.baseRef;
    return judged === base ? undefined : judged;
  };
  return {
    unproven: (headSha, base) => {
      const judged = judgedElsewhere(headSha, base);
      const read = reads.get(`${headSha}@${base}`);
      if (judged === undefined || (read !== undefined && read.unproven === undefined)) return undefined;
      return `the fix-proof at ${headSha} judged base ${judged}, not ${base}, the base being decided, and ${read?.unproven ?? `no fix-proof read on ${base} has been taken`}`;
    },
    reread: async (ctx, headSha, base) => {
      const evidence = current(headSha);
      if (base === undefined || evidence === undefined || judgedElsewhere(headSha, base) === undefined || decidedWithout(ctx, headSha, base)) return;
      const proof = await readFixProofAt(ctx, { repo: evidence.record.repo, head: headSha, base });
      reads.set(`${headSha}@${base}`, await baseReadOf(ctx, headSha, base, proof));
    },
  };
}

/** A record made before this read existed goes on to another step, and its recorded decision stands without it. */
function decidedWithout(ctx: WorkflowContext, headSha: string, base: string): boolean {
  const next = ctx.historyNext();
  return next !== undefined && next !== fixProofStepId(headSha, base);
}

/** Only a clean standing or the owner's waiver proves the head; anything else names why it does not. */
async function baseReadOf(ctx: WorkflowContext, headSha: string, base: string, proof: z.infer<typeof FixProofReadSchema>): Promise<BaseRead> {
  const gated = await proofStandingAt(ctx, headSha, proof);
  if ("ended" in gated) return { unproven: `its fix-proof on ${base} is NO_REPRO${"verdict" in proof ? ` (${proof.verdict})` : ""}` };
  const { standing } = gated;
  if (standing.waivedAt !== undefined || standing.unverified === undefined) return {};
  return { unproven: `its fix-proof on ${base} is unverified: ${proofUnverifiedOf(standing)}` };
}
