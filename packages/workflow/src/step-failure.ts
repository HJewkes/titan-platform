import { StepFailedError, type WorkflowEvent } from "./types.js";

/** Wraps each step operation rather than each throw site, so a new `StepFailedError` path cannot skip the event. */
export async function reportingStepFailure<T>(emit: (event: WorkflowEvent) => void, runId: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof StepFailedError) emit({ type: "step_failed", runId, stepId: error.stepId, error: error.reason });
    throw error;
  }
}
