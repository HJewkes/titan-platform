import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step, type LandOutcome } from "../workflows/land.js";

export const STOPPED_STEP = "sh-stopped";
export const STOPPED_STEPS: readonly StepDeclaration[] = [{ id: STOPPED_STEP, kind: "dispatch" }];

const StoppedResult = z.looseObject({ reason: z.string() });

/** Records why a run ended without a merge, so the read model never mistakes a completed run for a merged one. */
export async function recordStopped(ctx: WorkflowContext, outcome: Exclude<LandOutcome, { kind: "merged" }>): Promise<LandOutcome> {
  const reason = outcome.kind === "stopped" ? outcome.reason : outcome.kind;
  await step(ctx, STOPPED_STEP, { kind: outcome.kind, reason, headSha: outcome.headSha }, StoppedResult);
  return outcome;
}

export const stoppedRoute = (now: () => number): StepRoute => codeRoute(STOPPED_STEP, now, async (input: object) => input);
