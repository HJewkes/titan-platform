/**
 * G17: a milestone look at a run's head on held-out cases. It is its own workflow run, so the parent's digest,
 * queue and keep decisions never read it; the host counts looks against `target.validator.maxLooks`.
 */
import type { WorkflowContext } from "@titan-design/workflow";
import { arStepId, type ArStepDeclaration } from "./manifest.js";
import { LookAggregateSchema } from "./ports.js";
import { step } from "./steps.js";

export const AUTORESEARCH_VALIDATE_WORKFLOW = "autoresearch-validate";

/** The look runs one step, so a host declares only that one. */
export const AUTORESEARCH_VALIDATE_STEPS: readonly ArStepDeclaration[] = [{ id: arStepId("validate"), kind: "dispatch" }];

function required(ctx: WorkflowContext, name: string): string {
  const value = ctx.param(name);
  if (!value) throw new Error(`${AUTORESEARCH_VALIDATE_WORKFLOW}: param ${name} is required`);
  return value;
}

/** Params `parent`, `pin`, `head`, `look` and an optional `frozenHash`, all from the parent's recorded pin and summary. */
export async function runValidatorLook(ctx: WorkflowContext): Promise<void> {
  const look = Number(required(ctx, "look"));
  if (!Number.isInteger(look) || look < 1) throw new Error(`${AUTORESEARCH_VALIDATE_WORKFLOW}: param look must be a positive integer`);
  const frozenHash = ctx.param("frozenHash");
  const input = { runId: required(ctx, "parent"), pin: required(ctx, "pin"), ...(frozenHash ? { frozenHash } : {}), look, head: required(ctx, "head") };
  await step(ctx, `${arStepId("validate")}:${look}`, input, LookAggregateSchema);
}
