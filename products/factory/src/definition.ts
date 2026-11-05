import type { WorkflowContext, WorkflowFn } from "@titan-design/workflow";

/** The ways a workflow function touches a step; each keys its memo differently. */
export type StepKind = "dispatch" | "seed" | "assisted" | "authorize";

export interface StepDeclaration {
  /** A bare id, or a family whose calls are `<id>:<suffix>` (for example `ci-wait:2`). */
  id: string;
  kind: StepKind;
  /** A fact the registry knows. The step is inserted before a live call site, and `unlessPast` skips it for a run past that point (C28). */
  notAfter?: string;
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

/** What the registered-step checks read of a step registry: the names its entries answer to. */
export interface RegisteredSteps {
  readonly entries: readonly { readonly name: string; readonly op: StepKind; readonly fact?: string }[];
}

const isRegistered = (registry: RegisteredSteps, stepId: string): boolean =>
  declarationFor(registry.entries.map((entry) => ({ id: entry.name, kind: entry.op })), stepId) !== undefined;

/** A recipe declares only steps the registry knows, so a step cannot reach a run without its effect class and kind. */
export function assertRegistered(definition: WorkflowDefinition, registry: RegisteredSteps): void {
  const missing = definition.steps.filter((step) => !isRegistered(registry, step.id)).map((step) => step.id);
  if (missing.length > 0) throw new Error(`workflow ${definition.name}: declared steps with no registry entry: ${missing.join(", ")}`);
}

/**
 * `notAfter` must name a fact some registered step meets, since an unknown fact blocks. The first declaration may not
 * carry it: before any call is answered from the record `historyNext` is undefined, so the step would run live and park
 * an in-flight run. With no registry no fact is known, so every `notAfter` is refused.
 */
export function assertNotAfter(definition: WorkflowDefinition, registry: RegisteredSteps | undefined): void {
  const facts = new Set((registry?.entries ?? []).flatMap((entry) => (entry.fact === undefined ? [] : [entry.fact])));
  definition.steps.forEach((step, index) => {
    if (step.notAfter === undefined) return;
    if (index === 0) throw new Error(`workflow ${definition.name}: the first step "${step.id}" may not declare notAfter`);
    if (!facts.has(step.notAfter)) throw new Error(`workflow ${definition.name}: step "${step.id}" declares notAfter "${step.notAfter}", a fact no registered step meets`);
  });
}

/** Step ids of the dispatch steps, the ones a route must cover. */
export function dispatchStepIds(definition: WorkflowDefinition): string[] {
  return definition.steps.filter((step) => step.kind === "dispatch").map((step) => step.id);
}

/** Wraps the runtime context so a call whose id or kind differs from the declaration, or that has no registry entry, fails the run. */
export function guardedContext(ctx: WorkflowContext, definition: WorkflowDefinition, registry?: RegisteredSteps): WorkflowContext {
  const check = (stepId: string, kind: StepKind): void => {
    if (registry && !isRegistered(registry, stepId)) throw new Error(`workflow ${definition.name}: ${kind}("${stepId}") is not a registered step`);
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
    capability: (name) => ctx.capability(name),
    iteration: (stepId) => ctx.iteration(stepId),
    historyNext: () => ctx.historyNext(),
    resumedGate: () => ctx.resumedGate(),
    recoveredInFlight: () => ctx.recoveredInFlight(),
    expireGates: (reason, isStale) => ctx.expireGates(reason, isStale),
    dispatch: async (stepId, template, options) => (check(stepId, "dispatch"), ctx.dispatch(stepId, template, options)),
    seed: async (stepId, fn) => (check(stepId, "seed"), ctx.seed(stepId, fn)),
    assisted: async (stepId, prompt, options) => (check(stepId, "assisted"), ctx.assisted(stepId, prompt, options)),
    authorize: async (stepId, request, options) => (check(stepId, "authorize"), ctx.authorize(stepId, request, options)),
  };
}
