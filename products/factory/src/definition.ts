import type { WorkflowContext, WorkflowFn } from "@titan-design/workflow";

/** The three ways a workflow function touches a step; each keys its memo differently. */
export type StepKind = "dispatch" | "seed" | "assisted";

export interface StepDeclaration {
  /** A bare id, or a family whose calls are `<id>:<suffix>` (for example `ci-wait:2`). */
  id: string;
  kind: StepKind;
}

export interface WorkflowDefinition {
  name: string;
  steps: readonly StepDeclaration[];
  run: WorkflowFn;
}

export function defineWorkflow(definition: WorkflowDefinition): WorkflowDefinition {
  return definition;
}

/** True when `stepId` is `id` itself or one call of the `id:` family. */
export function stepIdMatches(id: string, stepId: string): boolean {
  return stepId === id || stepId.startsWith(`${id}:`);
}

/** Longest declaration covering `stepId`, so `ci-wait-long` never shadows `ci-wait`. */
export function declarationFor(steps: readonly StepDeclaration[], stepId: string): StepDeclaration | undefined {
  return steps.filter((step) => stepIdMatches(step.id, stepId)).sort((a, b) => b.id.length - a.id.length)[0];
}

/**
 * One step id, one operation kind. Declarations match by id segment, so a reused id would make
 * the guard and the router disagree about which operation a call belongs to.
 */
export function assertDistinctStepIds(definition: WorkflowDefinition): void {
  const seen = new Map<string, StepKind>();
  for (const step of definition.steps) {
    const earlier = seen.get(step.id);
    if (earlier) throw new Error(`workflow ${definition.name}: step id "${step.id}" is declared as both ${earlier} and ${step.kind}`);
    seen.set(step.id, step.kind);
  }
}

/** Step ids of the dispatch steps, the ones a route must cover. */
export function dispatchStepIds(definition: WorkflowDefinition): string[] {
  return definition.steps.filter((step) => step.kind === "dispatch").map((step) => step.id);
}

/** Wraps the runtime context so a call whose id or kind differs from the declaration fails the run. */
export function guardedContext(ctx: WorkflowContext, definition: WorkflowDefinition): WorkflowContext {
  const check = (stepId: string, kind: StepKind): void => {
    const declared = declarationFor(definition.steps, stepId);
    if (declared?.kind !== kind) {
      throw new Error(`workflow ${definition.name}: ${kind}("${stepId}") does not match a declared ${kind} step`);
    }
  };
  return {
    runId: ctx.runId,
    workflowName: ctx.workflowName,
    signal: ctx.signal,
    param: (key) => ctx.param(key),
    iteration: (stepId) => ctx.iteration(stepId),
    dispatch: async (stepId, template, options) => (check(stepId, "dispatch"), ctx.dispatch(stepId, template, options)),
    seed: async (stepId, fn) => (check(stepId, "seed"), ctx.seed(stepId, fn)),
    assisted: async (stepId, prompt, options) => (check(stepId, "assisted"), ctx.assisted(stepId, prompt, options)),
  };
}
