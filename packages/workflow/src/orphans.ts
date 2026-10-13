import type { Registration } from "./definition-version.js";
import { announceRecovery, markStepRecovery, parkForRecovery } from "./recovery.js";
import type { ActiveStep, WorkflowEvent, WorkflowRun } from "./types.js";

/**
 * Asked, when a workflow returns, about each recovered step its replay never reached: true drops the step with a
 * `step_abandoned` event, false parks the run. A registration without one parks on every such orphan.
 */
export type AbandonsOrphan = (stepId: string) => boolean;

export type WorkflowRegistration = Registration & { abandonsOrphan?: AbandonsOrphan; strictReplay?: boolean };

interface OrphanHooks {
  save: (run: WorkflowRun) => void;
  emit: (event: WorkflowEvent) => void;
  now: () => string;
}

/** Drops each orphan `abandonsOrphan` allows, then marks the run for recovery on a step still active; true when it did. */
export function settleUnfinished(run: WorkflowRun, orphans: ActiveStep[], abandonsOrphan: AbandonsOrphan | undefined, hooks: OrphanHooks): boolean {
  const dropped = orphans.filter((step) => abandonsOrphan?.(step.stepId) === true);
  if (dropped.length > 0) {
    for (const step of dropped) delete run.activeSteps[step.stepId];
    hooks.save(run);
    for (const step of dropped) {
      hooks.emit({ type: "step_abandoned", runId: run.id, stepId: step.stepId, reason: "replay never reached recovered step" });
    }
  }
  const step = Object.values(run.activeSteps)[0];
  if (!step) return false;
  const evidence = orphans.includes(step)
    ? `replay never reached recovered step ${step.stepId}`
    : `workflow returned while step ${step.stepId} still required reconciliation`;
  markStepRecovery(step, "unknown", evidence, hooks.now());
  parkForRecovery(run, evidence);
  announceRecovery(hooks.emit, run.id, step.stepId, evidence);
  hooks.save(run);
  return true;
}
