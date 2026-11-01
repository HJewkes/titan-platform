import { endsReview, proofStanding } from "@titan-design/fix-proof";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { fixProofRoute, noReproOf, unverifiedOf, type FixProofReadSchema } from "./fix-proof.js";
import { proofBaseOf } from "./fix-proof-base.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import type { ProofStanding } from "./take-verdict.js";

const WAIVE_PROOF_STEP = "sh-fix-proof-waive";
const PROOF_WAIVER_STEP = "sh-fix-proof-waived";

export const PROOF_WAIVER_STEPS: readonly StepDeclaration[] = [
  { id: WAIVE_PROOF_STEP, kind: "dispatch" },
  { id: PROOF_WAIVER_STEP, kind: "dispatch" },
];

const WaiverInput = z.object({ runId: z.string().min(1), head: z.string().min(1) });
const Waived = z.looseObject({ waived: z.boolean() });

/** The fix-proof read and the waiver steps that can let a NO_REPRO head past it. */
export const fixProofRoutes = (deps: ShepherdDeps): StepRoute[] => [
  fixProofRoute(deps),
  codeRoute(WAIVE_PROOF_STEP, deps.now, async (raw: unknown) => {
    const { runId, head } = WaiverInput.parse(raw);
    deps.store.get().proofWaivers().waive(runId, head);
    return { waived: true };
  }),
  codeRoute(PROOF_WAIVER_STEP, deps.now, async (raw: unknown) => {
    const { runId, head } = WaiverInput.parse(raw);
    return { waived: deps.store.get().proofWaivers().waivedAt(runId, head) };
  }),
];

/** Records the owner's waiver of `head`'s fix-proof for this run. */
export async function waiveProof(ctx: WorkflowContext, head: string): Promise<void> {
  await step(ctx, WAIVE_PROOF_STEP, { runId: ctx.runId, head }, Waived);
}

/**
 * Whether the owner waived `head`'s fix-proof in this run. A run that never waived reads nothing, so the history of a run
 * recorded before waivers existed replays without a step it does not hold.
 */
async function proofWaivedAt(ctx: WorkflowContext, head: string): Promise<boolean> {
  if (ctx.iteration(WAIVE_PROOF_STEP) === 0) return false;
  return (await step(ctx, `${PROOF_WAIVER_STEP}:${head}`, { runId: ctx.runId, head }, Waived)).waived;
}

/**
 * The head's proof standing, or the NO_REPRO that ends its review before any reviewer starts. A head that proceeds on its NO_REPRO can
 * still come back as the panel's NO_REPRO, so its waiver is read too.
 */
export async function proofStandingAt(ctx: WorkflowContext, head: string, proof: z.infer<typeof FixProofReadSchema>): Promise<{ ended: Verdict } | { standing: ProofStanding }> {
  const read = proofStanding(proof, head);
  const noRepro = noReproOf(read, head);
  const unverified = unverifiedOf(read);
  const proceeds = noRepro !== undefined && !endsReview(read);
  const waived = noRepro !== undefined && (await proofWaivedAt(ctx, head));
  if (noRepro && !proceeds && !waived) return { ended: noRepro };
  const proofBase = proofBaseOf(proof, head);
  const standing: ProofStanding = waived ? { waivedAt: head } : unverified ? { ...unverified, ...(typeof proof.reason === "string" && { reason: proof.reason }) } : {};
  return { standing: { ...standing, ...(proofBase !== undefined && { proofBase }) } };
}
