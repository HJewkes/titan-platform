import type { RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step, type LandOutcome } from "../workflows/land.js";

/** The two steps that record how a run ended; the watch row reads its `outcome` from them. */
export const OUTCOME_STEPS: readonly StepDeclaration[] = [
  { id: "sh-landed", kind: "dispatch" },
  { id: "sh-stopped", kind: "dispatch" },
];

const LandedResult = z.looseObject({ mergeSha: z.string() });
const StoppedResult = z.looseObject({ reason: z.string() });

export async function recordLanded(ctx: WorkflowContext, target: { repo: RepoSlug; pr: number }, merged: Extract<LandOutcome, { kind: "merged" }>): Promise<void> {
  await step(ctx, "sh-landed", { ...target, headSha: merged.headSha, mergeSha: merged.mergeSha }, LandedResult);
}

/** Records why a run ended without a merge, so the read model never mistakes a completed run for a merged one. */
export async function recordStopped(ctx: WorkflowContext, outcome: Exclude<LandOutcome, { kind: "merged" }>): Promise<LandOutcome> {
  const reason = outcome.kind === "stopped" ? outcome.reason : outcome.kind;
  await step(ctx, "sh-stopped", { kind: outcome.kind, reason, headSha: outcome.headSha }, StoppedResult);
  return outcome;
}

/** Both steps echo their input, so each repeats safely after a crash. */
export const outcomeRoutes = (now: () => number): StepRoute[] => ["sh-landed", "sh-stopped"].map((id) => codeRoute(id, now, async (input: object) => input));
