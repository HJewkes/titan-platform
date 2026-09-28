import { idempotentRunner } from "./runners.js";
import type { RecoverableStepRunner, StepReconcileOutcome, StepRunInput, StepRunOutcome } from "./types.js";

/** `repeat` re-dispatches a step interrupted by a crash; `park` leaves the run recovery_required for a human. */
export type RestartRule = "repeat" | "park";

/** What a route's runner receives: the runtime's own input, plus the attempt and request key that name this try. */
export interface RoutedStepInput extends StepRunInput {
  attempt: number;
  requestKey: string;
}

export interface RouteRunner {
  run(input: RoutedStepInput): Promise<StepRunOutcome>;
}

export interface StepRoute {
  /** A step id, which also covers that id's `<id>:<suffix>` family; the longest matching route wins. */
  match: string;
  runner: RouteRunner;
  onRestart: RestartRule;
}

export interface RoutedRunner extends RecoverableStepRunner {
  routeFor(stepId: string): StepRoute | undefined;
  /** Throws naming every step id in `stepIds` that no route covers; call it when registering `workflowName`. */
  assertRoutes(workflowName: string, stepIds: readonly string[]): void;
}

/** One runner for the runtime; each dispatch step goes to the runner and restart rule its route names. */
export function routedRunner(routes: readonly StepRoute[]): RoutedRunner {
  assertDistinctMatches(routes);
  const routeFor = (stepId: string) => longestRoute(routes, stepId);
  return {
    routeFor,
    assertRoutes(workflowName, stepIds) {
      const unrouted = stepIds.filter((stepId) => !routeFor(stepId));
      if (unrouted.length > 0) throw new Error(`workflow ${workflowName}: no route for ${unrouted.join(", ")}`);
    },
    async dispatch(input) {
      const route = routeFor(input.stepId);
      if (!route) throw new Error(`no route for step ${input.stepId}`);
      return idempotentRunner({ run: () => route.runner.run(input) }).dispatch(input);
    },
    async reconcile(step): Promise<StepReconcileOutcome> {
      const rule = routeFor(step.stepId)?.onRestart;
      if (rule === "repeat") return { kind: "not_found", retrySafe: true, evidence: `step ${step.stepId} is routed repeat and did not survive the restart` };
      return { kind: "unknown", evidence: `step ${step.stepId} is routed ${rule ?? "nowhere"}; its effect may have happened, so a human decides` };
    },
  };
}

function routeCovers(match: string, stepId: string): boolean {
  return stepId === match || stepId.startsWith(`${match}:`);
}

/** Longest match first, so a `ci-wait:final` route overrides the `ci-wait` family it belongs to. */
function longestRoute(routes: readonly StepRoute[], stepId: string): StepRoute | undefined {
  return routes.filter((route) => routeCovers(route.match, stepId)).sort((a, b) => b.match.length - a.match.length)[0];
}

function assertDistinctMatches(routes: readonly StepRoute[]): void {
  const seen = new Set<string>();
  for (const { match } of routes) {
    if (seen.has(match)) throw new Error(`two routes match step id "${match}"`);
    seen.add(match);
  }
}
