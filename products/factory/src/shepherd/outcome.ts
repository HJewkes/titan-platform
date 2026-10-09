import type { RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import type { OwnerOverride } from "./override-stats.js";
import { codeRoute, step, type LandOutcome } from "../workflows/land.js";

const OVERRIDE_STEP = "sh-override";

/** The steps that record how a run ended; the watch row reads its `outcome` from them. */
export const OUTCOME_STEPS: readonly StepDeclaration[] = [
  { id: "sh-landed", kind: "dispatch" },
  { id: "sh-stopped", kind: "dispatch" },
  { id: OVERRIDE_STEP, kind: "dispatch" },
];

const LandedResult = z.looseObject({ mergeSha: z.string().nullable() });
const OverrideResult = z.looseObject({ ownerOverride: z.looseObject({ head: z.string() }) });
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

/** The owner's answer overturned a MERGE verdict; one step per head, because an abandon ends the run. */
export async function recordOverride(ctx: WorkflowContext, target: { repo: RepoSlug; pr: number }, ownerOverride: Omit<OwnerOverride, "at">): Promise<void> {
  await step(ctx, `${OVERRIDE_STEP}:${ownerOverride.head}`, { ...target, ownerOverride }, OverrideResult);
}

/** Each step echoes its input, so it repeats safely after a crash; the override adds the clock reading. */
export const outcomeRoutes = (now: () => number): StepRoute[] => [
  ...["sh-landed", "sh-stopped"].map((id) => codeRoute(id, now, async (input: object) => input)),
  codeRoute(OVERRIDE_STEP, now, async (input: { ownerOverride: object }) => ({ ...input, ownerOverride: { ...input.ownerOverride, at: now() } })),
];
