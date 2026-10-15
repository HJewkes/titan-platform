import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { step } from "../workflows/land.js";
import type { WakeOutcome, WakeRequest } from "./phases.js";

export const FIX_PROOF_WAKE_STEP = "sh-wake-fix-proof";
/** Fix-proof wakes a run may spend; the next one goes to the owner gate, so a fix whose test never reproduces the bug cannot bounce forever. */
export const MAX_FIX_PROOF_WAKES = 2;

const FixProofWakeRecord = z.looseObject({ wake: z.number().int().positive() });

/**
 * Each fix-proof wake is a step record written before the wake, so a replay sees the count it had; a live-exit
 * redelivery is the same wake and is not counted again. The capped wake carries no `held`, so the owner gate decides.
 */
export async function fixProofBounce(ctx: WorkflowContext, request: WakeRequest): Promise<WakeOutcome | undefined> {
  if (request.kind !== "fix-proof") return undefined;
  const wakes = ctx.iteration(FIX_PROOF_WAKE_STEP);
  if (wakes >= MAX_FIX_PROOF_WAKES) return { kind: "unhandled", reason: `${MAX_FIX_PROOF_WAKES} fix-proof wakes on ${request.repo}#${request.pr} have not produced a test that reproduces the bug, so the owner decides` };
  await step(ctx, FIX_PROOF_WAKE_STEP, { repo: request.repo, pr: request.pr, headSha: request.headSha, wake: wakes + 1 }, FixProofWakeRecord);
  return undefined;
}
