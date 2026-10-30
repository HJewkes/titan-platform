import type { WorkflowEvent } from "@titan-design/workflow";
import type { FactoryRoutes } from "../host.js";
import { pruneChores, type ChorePorts, type StepTrace } from "./post-merge-chore.js";

const POST_MERGE_STEP = "post-merge";
const isPostMerge = (stepId: string): boolean => stepId === POST_MERGE_STEP || stepId.startsWith(`${POST_MERGE_STEP}:`);

function prune(dir: string, settled: (step: StepTrace) => boolean): void {
  try {
    pruneChores(dir, settled);
  } catch (error) {
    // A prune that fails leaves files behind; it must never fail a run.
    console.warn(`[chores] pruning ${dir} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Removes a post-merge chore's files once its step has a recorded result: on the step's `step_complete`, which the
 * workflow emits only after the result is saved, and on host bind for sets a crash between the two left behind.
 */
export function chorePruning(chores: ChorePorts | undefined): Pick<FactoryRoutes, "bindHost" | "onEvent"> {
  if (!chores) return {};
  return {
    onEvent(event: WorkflowEvent) {
      if (event.type !== "step_complete" || !isPostMerge(event.stepId)) return;
      prune(chores.dir, (step) => step.runId === event.runId && step.stepId === event.stepId && step.iteration === event.iteration);
    },
    bindHost(host) {
      prune(chores.dir, (step) => {
        const results = host.runs.get(step.runId)?.stepResults ?? {};
        return Object.values(results).some((result) => result.stepId === step.stepId && result.iteration === step.iteration);
      });
      return () => undefined;
    },
  };
}
