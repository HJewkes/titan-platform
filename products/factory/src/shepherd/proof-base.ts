import type { WorkflowContext } from "@titan-design/workflow";
import type { z } from "zod";
import { fixProofStepId, proofBaseOf, readFixProofAt, type FixProofReadSchema } from "./fix-proof.js";
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
  /** Takes the read on `base` before a decision when the proof judged another base, or none, and none was taken at the head yet. */
  readIfUnread: (ctx: WorkflowContext, headSha: string, base: string) => Promise<void>;
  /** Reads the head's fix-proof on `base` when its proof judged another, so the next decision judges that read; no base reads nothing. */
  reread: (ctx: WorkflowContext, headSha: string, base: string | undefined) => Promise<void>;
}

/**
 * `current` is the evidence as last re-read, which keeps the review's `proofBase`. Only a `proofBase` equal to the decided base
 * proves the head there; a record with none proved no base, so it gates until a read on the decided base shows it. A head with no
 * MERGE evidence has no proof to guard, and the policy gates it on the missing facts.
 */
export function proofOnBase(current: EvidenceAt): ProofOnBase {
  const reads = new Map<string, BaseRead>();
  const judgedElsewhere = (headSha: string, base: string): string | undefined => {
    const evidence = current(headSha);
    if (evidence === undefined || evidence.record.proofBase === base) return undefined;
    return evidence.record.proofBase === undefined ? "no base" : `base ${evidence.record.proofBase}`;
  };
  const unproven = (headSha: string, base: string): string | undefined => {
    const judged = judgedElsewhere(headSha, base);
    const read = reads.get(`${headSha}@${base}`);
    if (judged === undefined || (read !== undefined && read.unproven === undefined)) return undefined;
    return `the fix-proof at ${headSha} judged ${judged}, not ${base}, the base being decided, and ${read?.unproven ?? `no fix-proof read on ${base} has been taken`}`;
  };
  const reread = async (ctx: WorkflowContext, headSha: string, base: string | undefined): Promise<void> => {
    const evidence = current(headSha);
    if (base === undefined || evidence === undefined || judgedElsewhere(headSha, base) === undefined || decidedWithout(ctx, headSha, base)) return;
    const proof = await readFixProofAt(ctx, { repo: evidence.record.repo, head: headSha, base });
    reads.set(`${headSha}@${base}`, await baseReadOf(ctx, headSha, base, proof));
  };
  return {
    unproven,
    reread,
    readIfUnread: async (ctx, headSha, base) => (reads.has(`${headSha}@${base}`) ? undefined : reread(ctx, headSha, base)),
  };
}

/** A record made before this read existed goes on to another step, and its recorded decision stands without it. */
function decidedWithout(ctx: WorkflowContext, headSha: string, base: string): boolean {
  const next = ctx.historyNext();
  return next !== undefined && next !== fixProofStepId(headSha, base);
}

/** Reads that prove the head on any base: the registered kind needs no proof, or the base runs no fix-proof workflow and the PR left the harness alone. */
const PROVEN_ON_ANY_BASE: ReadonlySet<string> = new Set(["skipped", "missing"]);

/**
 * Only positive proof at `base` clears: a clean line or proved CI read that names `base`, a read that needs no proof there, or
 * the owner's waiver at the head. A clean read that names no base, or another one, proves nothing about `base`.
 */
async function baseReadOf(ctx: WorkflowContext, headSha: string, base: string, proof: z.infer<typeof FixProofReadSchema>): Promise<BaseRead> {
  const gated = await proofStandingAt(ctx, headSha, proof);
  if ("ended" in gated) return { unproven: `its fix-proof on ${base} is NO_REPRO${"verdict" in proof ? ` (${proof.verdict})` : ""}` };
  const { standing } = gated;
  if (standing.waivedAt !== undefined) return {};
  if (standing.unverified !== undefined) return { unproven: `its fix-proof on ${base} is unverified: ${proofUnverifiedOf(standing)}` };
  if (PROVEN_ON_ANY_BASE.has(proof.kind) || proofBaseOf(proof, headSha) === base) return {};
  return { unproven: `its fix-proof read on ${base} names ${proofBaseOf(proof, headSha) ?? "no base"}, not ${base}` };
}
