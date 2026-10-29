import { StepFailedError, WorkflowCancelledError, type AssistedOptions, type StepResult, type WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { agentNameOf, branchOf, type BuildSpec, type Slice } from "./spec.js";

const INPUT_VAR = "BS_STEP_INPUT";

/** One slice's view of the run: its steps carry `<step>:<slice>[:<suffix>]` ids, and its spend is counted against its cap. */
export interface SliceRun {
  ctx: WorkflowContext;
  spec: BuildSpec;
  slice: Slice;
  agent: string;
  branch: string;
  spentUsd: number;
  brokenGateRuns: number;
  halt: RunHalt;
  last?: StepResult;
}

/**
 * Shared by every slice of a run. A cancel thrown inside one `mapItems` item ends only that item while the batch waits
 * on its siblings, so the first cancel records its reason here and each sibling stops at its next step or owner gate.
 */
export interface RunHalt {
  reason: string | null;
}

export function sliceRun(ctx: WorkflowContext, spec: BuildSpec, slice: Slice, halt: RunHalt): SliceRun {
  return { ctx, spec, slice, agent: agentNameOf(spec, slice), branch: branchOf(slice), spentUsd: 0, brokenGateRuns: 0, halt };
}

/** Cancels the whole run: this slice ends now, and every sibling still in flight ends before its next step. */
export function cancelRun(run: SliceRun, reason: string): never {
  run.halt.reason ??= reason;
  throw new WorkflowCancelledError(run.ctx.runId, reason);
}

function stopIfHalted(run: SliceRun): void {
  if (run.halt.reason !== null) throw new WorkflowCancelledError(run.ctx.runId, `slice ${run.slice.id} ended because the run was cancelled: ${run.halt.reason}`);
}

/** Stops this slice only: retryable, so `mapItems` counts it against `maxFailures` and the other slices go on. */
export function stopSlice(run: SliceRun, reason: string): never {
  throw new StepFailedError(`bs-slice:${run.slice.id}`, 0, `slice ${run.slice.id} stopped: ${reason}`, { retryable: true, usage: { costUsd: run.spentUsd } });
}

/** Every dispatch carries its input as JSON; the route answers under `result`, checked by `schema`. */
export async function sliceStep<R>(run: SliceRun, step: string, suffix: string | number | undefined, input: object, schema: z.ZodType<R>): Promise<R> {
  stopIfHalted(run);
  const stepId = `${step}:${run.slice.id}${suffix === undefined ? "" : `:${suffix}`}`;
  const result = await run.ctx.dispatch(stepId, `{{${INPUT_VAR}}}`, { vars: { [INPUT_VAR]: JSON.stringify(input) }, schema: z.looseObject({ result: schema }) });
  run.last = result;
  run.spentUsd += result.usage?.costUsd ?? 0;
  if (run.spentUsd > run.spec.sliceBudgetUsd) stopSlice(run, `spend $${run.spentUsd.toFixed(2)} is over the slice cap of $${run.spec.sliceBudgetUsd}`);
  return result.data!.result;
}

/** An owner gate for this slice, never opened once the run is cancelled. */
export async function sliceAsk(run: SliceRun, stepId: string, prompt: string, options: AssistedOptions): Promise<StepResult> {
  stopIfHalted(run);
  return run.ctx.assisted(stepId, prompt, options);
}

/** The env every repo command gets, so a gate or deploy script knows which slice and head it runs for. */
function sliceEnv(run: SliceRun, extra: Record<string, string> = {}): Record<string, string> {
  return { BS_REPO: run.spec.repo, BS_SLICE: run.slice.id, BS_BRANCH: run.branch, BS_BASE: run.spec.base, ...extra };
}

/** A repo command's step input: its argv, run in the clone with the slice's env. */
export function commandIn(run: SliceRun, argv: string[] | undefined, extra: Record<string, string> = {}) {
  return { ...(argv && { argv }), cwd: run.spec.clone, env: sliceEnv(run, extra) };
}

/** An owner gate's brief: one question with the given options, its evidence the commit it is asked about. */
export function oneQuestionBrief(run: SliceRun, summary: string, sha: string, question: string, options: { id: string; label: string }[]) {
  return { summary: summary.slice(0, 280), evidenceRef: `https://github.com/${run.spec.repo}/commit/${sha}`, questions: [{ id: "decision", question, options }] };
}
