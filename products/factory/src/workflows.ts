import type { WorkflowDefinition } from "./definition.js";
import type { StepRoute } from "./routed-runner.js";

/** Every workflow the CLI hosts. Pilots register here as their slices land (doc-change in S3). */
export const factoryWorkflows: readonly WorkflowDefinition[] = [];

/** Routes for every dispatch step of `factoryWorkflows`. */
export const factoryRoutes: readonly StepRoute[] = [];
