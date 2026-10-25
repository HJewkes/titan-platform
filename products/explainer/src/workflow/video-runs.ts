import type { WorkflowRun, WorkflowRunStore } from "@titan-design/workflow";
import { RunPlanSchema, VIDEO_WORKFLOW, type RunPlan } from "./pipeline.js";
import type { VideoRef } from "./stage-spec.js";

export const planOf = (run: WorkflowRun): RunPlan => RunPlanSchema.parse(JSON.parse(run.params.plan ?? "{}"));

/** A run's video: its plan's, else its base run's, else (the first run of a video) its own id. */
export function videoIdOf(runs: WorkflowRunStore, run: WorkflowRun, seen = new Set<string>()): string {
  const plan = planOf(run);
  if (plan.videoId) return plan.videoId;
  const base = plan.baseRunId && !seen.has(plan.baseRunId) ? runs.get(plan.baseRunId) : undefined;
  return base ? videoIdOf(runs, base, seen.add(run.id)) : run.id;
}

const videoRuns = (runs: WorkflowRunStore): WorkflowRun[] =>
  runs.listByStatus(["running", "paused", "recovery_required", "completed", "failed", "cancelled"]).filter((run) => run.workflowName === VIDEO_WORKFLOW);

export const runsOfVideo = (runs: WorkflowRunStore, videoId: string): WorkflowRun[] =>
  videoRuns(runs).filter((run) => videoIdOf(runs, run) === videoId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));

/** A video and every run of it, oldest first, as the sheets stage's sidecar lists them. */
export function videoRef(runs: WorkflowRunStore, videoId: string): VideoRef {
  const runIds = runsOfVideo(runs, videoId).map((run) => run.id);
  if (runIds.length === 0) throw new Error(`no ${VIDEO_WORKFLOW} run belongs to video ${videoId}`);
  return { id: videoId, runIds };
}

/** The video `runId` makes, with every run of it, the run itself included. */
export function runVideoRef(runs: WorkflowRunStore, runId: string): VideoRef {
  const run = runs.get(runId);
  if (!run) throw new Error(`no ${VIDEO_WORKFLOW} run ${runId}`);
  return videoRef(runs, videoIdOf(runs, run));
}

