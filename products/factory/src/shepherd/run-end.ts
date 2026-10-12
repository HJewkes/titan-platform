import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import type { Phase } from "./step-phase.js";

export const TERMINAL_PHASE: Partial<Record<WorkflowRun["status"], Phase>> = { completed: "done", failed: "failed", cancelled: "cancelled" };

/** The step that recorded how the run ended: sh-landed first, then sh-stopped. */
function outcomeStep(steps: readonly StepResult[]): StepResult | undefined {
  return steps.find((result) => result.stepId.startsWith("sh-landed")) ?? steps.find((result) => result.stepId.startsWith("sh-stopped"));
}

/**
 * When the run ended, or undefined while it runs. A run the runtime parked in recovery after it recorded its outcome
 * has ended at that outcome; a paused or running run with one may still watch main CI after the merge.
 */
export function endedAt(run: WorkflowRun, steps: readonly StepResult[]): string | undefined {
  if (TERMINAL_PHASE[run.status]) return run.completedAt ?? run.startedAt;
  return run.status === "recovery_required" ? outcomeStep(steps)?.completedAt : undefined;
}

const StoppedData = z.object({ result: z.object({ reason: z.string() }) });

/** How a finished run ended, from its sh-landed or sh-stopped step; null while neither is recorded. */
export function runOutcome(steps: readonly StepResult[]): { kind: "merged" | "stopped"; reason: string | null } | null {
  const step = outcomeStep(steps);
  if (step?.stepId.startsWith("sh-landed")) return { kind: "merged", reason: null };
  const parsed = step && StoppedData.safeParse(step.data);
  return parsed ? { kind: "stopped", reason: parsed.success ? parsed.data.result.reason : null } : null;
}
