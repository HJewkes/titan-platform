import type { WorkflowRun, WorkflowRunStore } from "@titan-design/workflow";
import { RunPlanSchema, type RunPlan } from "./pipeline.js";

export const planOf = (run: WorkflowRun): RunPlan => RunPlanSchema.parse(JSON.parse(run.params.plan ?? "{}"));

/** A run's video: its plan's, else its base run's, else (the first run of a video) its own id. */
export function videoIdOf(runs: WorkflowRunStore, run: WorkflowRun, seen = new Set<string>()): string {
  const plan = planOf(run);
  if (plan.videoId) return plan.videoId;
  const base = plan.baseRunId && !seen.has(plan.baseRunId) ? runs.get(plan.baseRunId) : undefined;
  return base ? videoIdOf(runs, base, seen.add(run.id)) : run.id;
}
