import type { WorkflowEvent } from "@titan-design/workflow";
import type { FactoryRoutes } from "../host.js";
import type { WorkflowStatus } from "@titan-design/workflow";
import { choreState, listChores, pruneChores, removeChore, type ChorePorts, type StepTrace } from "./post-merge-chore.js";

/** A launch writes its marker before it has a handle; inside this window a handle-less marker may still be launching. */
export const LAUNCH_GRACE_MS = 60_000;
const FINAL_STATUSES: readonly WorkflowStatus[] = ["completed", "failed", "cancelled"];
const FINAL_EVENTS: readonly WorkflowEvent["type"][] = ["workflow_complete", "workflow_failed", "workflow_cancelled"];

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
 * Removes the files of chores whose run is final but never recorded the post-merge step. A chore still running keeps its
 * files, as does a run that is active (a parked one is resumed from them), absent from the store, or has an unreadable marker.
 */
export async function sweepFinalRuns(ports: ChorePorts, runs: { get(id: string): { status: WorkflowStatus } | undefined }, now: number): Promise<string[]> {
  const swept: string[] = [];
  for (const { id, files, marker } of listChores(ports.dir)) {
    const status = runs.get(marker.step.runId)?.status;
    if (status === undefined || !FINAL_STATUSES.includes(status)) continue;
    const state = await choreState(ports, files);
    if (state.kind === "running" || state.kind === "never-started") continue;
    const launching = state.kind === "lost" && !marker.handle && now - Date.parse(marker.started) < LAUNCH_GRACE_MS;
    if (launching) continue;
    removeChore(ports.dir, id);
    swept.push(id);
  }
  return swept;
}

/** One sweep at a time; a trigger that arrives meanwhile earns one more pass, since the run it names may have been missed. */
function serialised(sweep: () => Promise<unknown>): () => void {
  let running = false;
  let requests = 0;
  const run = async (): Promise<void> => {
    requests += 1;
    if (running) return;
    running = true;
    try {
      for (let served = 0; served < requests; ) {
        served = requests;
        await sweep();
      }
    } catch (error) {
      // A sweep that fails leaves files behind; it must never fail a run.
      console.warn(`[chores] sweeping final runs failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };
  return () => void run();
}

/**
 * Removes a post-merge chore's files once its step has a recorded result: on the step's `step_complete`, which the
 * workflow emits only after the result is saved, and on host bind for sets a crash between the two left behind.
 */
export function chorePruning(chores: ChorePorts | undefined, now: () => number = Date.now): Pick<FactoryRoutes, "bindHost" | "onEvent"> {
  if (!chores) return {};
  let sweepFinal: (() => void) | undefined;
  return {
    onEvent(event: WorkflowEvent) {
      if (FINAL_EVENTS.includes(event.type)) sweepFinal?.();
      if (event.type !== "step_complete" || !isPostMerge(event.stepId)) return;
      prune(chores.dir, (step) => step.runId === event.runId && step.stepId === event.stepId && step.iteration === event.iteration);
    },
    bindHost(host) {
      prune(chores.dir, (step) => {
        const results = host.runs.get(step.runId)?.stepResults ?? {};
        return Object.values(results).some((result) => result.stepId === step.stepId && result.iteration === step.iteration);
      });
      sweepFinal = serialised(() => sweepFinalRuns(chores, host.runs, now()));
      sweepFinal();
      return () => {
        sweepFinal = undefined;
      };
    },
  };
}
