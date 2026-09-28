import {
  idempotentRunner,
  type RecoverableStepRunner,
  type StepReconcileOutcome,
  type StepRunInput,
  type StepRunOutcome,
} from "@titan-design/workflow";
import { declarationFor, type WorkflowDefinition } from "./definition.js";

/** `repeat` re-dispatches a step interrupted by a crash; `park` leaves the run recovery_required for a human. */
export type RestartRule = "repeat" | "park";

/** What a route's runner receives: the runtime's own input, including the attempt that names the span. */
export interface RoutedStepInput extends StepRunInput {
  attempt: number;
  requestKey: string;
}

export interface RouteRunner {
  run(input: RoutedStepInput): Promise<StepRunOutcome>;
}

export interface StepRoute {
  /** A step id or family, matched as in `stepIdMatches`. */
  match: string;
  runner: RouteRunner;
  onRestart: RestartRule;
}

export interface RoutedRunner extends RecoverableStepRunner {
  routeFor(stepId: string): StepRoute | undefined;
  /** Throws unless every dispatch step of `definition` has a route. */
  assertRoutes(definition: WorkflowDefinition): void;
}

/** One runner kind for the runtime, many runners and restart rules for the steps. */
export function routedRunner(routes: readonly StepRoute[]): RoutedRunner {
  const declarations = routes.map((route) => ({ id: route.match, kind: "dispatch" as const }));
  const routeFor = (stepId: string): StepRoute | undefined => {
    const hit = declarationFor(declarations, stepId);
    return hit && routes.find((route) => route.match === hit.id);
  };
  return {
    routeFor,
    assertRoutes(definition) {
      const unrouted = definition.steps.filter((step) => step.kind === "dispatch" && !routeFor(step.id));
      if (unrouted.length > 0) throw new Error(`workflow ${definition.name}: no route for ${unrouted.map((step) => step.id).join(", ")}`);
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
