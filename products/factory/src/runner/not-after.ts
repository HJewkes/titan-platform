import type { WorkflowContext } from "@titan-design/workflow";
import { declarationFor, stepIdMatches, type WorkflowDefinition } from "../definition.js";
import type { NotAfterShadow } from "../markers/shadow.js";

interface RunnerScope {
  definition: WorkflowDefinition;
  shadow: NotAfterShadow | undefined;
  /** Step calls started on this context and not yet settled; above zero, sibling children are running concurrently. */
  inFlight: number;
}

const scopes = new WeakMap<WorkflowContext, RunnerScope>();

type UnlessPast<R> = { skipped: true } | { skipped: false; value: R };

/** The context a recipe body runs with: it knows the recipe's declarations and counts its in-flight calls for `unlessPast`. */
export function runnerContext(ctx: WorkflowContext, definition: WorkflowDefinition, shadow?: NotAfterShadow): WorkflowContext {
  const scope: RunnerScope = { definition, shadow, inFlight: 0 };
  const track = async <R>(call: () => Promise<R>): Promise<R> => {
    scope.inFlight += 1;
    try {
      return await call();
    } finally {
      scope.inFlight -= 1;
    }
  };
  const wrapped: WorkflowContext = {
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
    dispatch: (stepId, template, options) => track(() => ctx.dispatch(stepId, template, options)),
    seed: (stepId, fn) => track(() => ctx.seed(stepId, fn)),
    assisted: (stepId, prompt, options) => track(() => ctx.assisted(stepId, prompt, options)),
    authorize: (stepId, request, options) => track(() => ctx.authorize(stepId, request, options)),
  };
  scopes.set(wrapped, scope);
  return wrapped;
}

/**
 * C28: runs a step inserted before a live call site, unless the run's record continues past this point without it. Such
 * a run took this path before the step existed, so its replay keeps that path (the rule hand-rolled in `ci-unread.ts`).
 */
export async function unlessPast<R>(ctx: WorkflowContext, stepId: string, call: () => Promise<R>): Promise<UnlessPast<R>> {
  const scope = scopes.get(ctx);
  if (!scope) throw new Error(`unlessPast("${stepId}") needs the factory host's runner context`);
  const notAfter = declarationFor(scope.definition.steps, stepId)?.notAfter;
  if (notAfter === undefined) throw new Error(`workflow ${scope.definition.name}: unlessPast("${stepId}") needs a step declared with notAfter`);
  // Siblings started in the same tick have begun their first call by the next microtask.
  await Promise.resolve();
  if (scope.inFlight > 0) throw new Error(`workflow ${scope.definition.name}: unlessPast("${stepId}") inside all: historyNext is ambiguous across concurrent children`);
  const next = ctx.historyNext();
  if (next !== undefined && !stepIdMatches(stepId, next)) {
    scope.shadow?.skipped(stepId, notAfter);
    return { skipped: true };
  }
  if (next === undefined) await scope.shadow?.live(stepId, notAfter);
  return { skipped: false, value: await call() };
}
