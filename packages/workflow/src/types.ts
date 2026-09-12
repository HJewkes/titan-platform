import type { ZodType } from "zod";

export type WorkflowStatus = "running" | "paused" | "cancelling" | "recovery_required" | "completed" | "failed" | "cancelled";

export interface WorkflowOwnerFence {
  runtimeId: string;
  generation: number;
}

export interface WorkflowOwnerLease extends WorkflowOwnerFence {
  leaseUntil: string;
}

export interface StepResult {
  stepId: string;
  iteration: number;
  /** Runner-assigned id (an agent session id, a job id); null for seed and gate steps. */
  agentId: string | null;
  /** Condition signal parsed from the output, e.g. `needs_revision`. */
  signal: string | null;
  completedAt: string;
  output?: string;
  /** Structured payload: a seed's data or a gate's resolution. */
  data?: Record<string, unknown>;
}

export interface ActiveStepBase {
  stepId: string;
  iterKey: string;
  attempt: number;
  startedAt: string;
  runnerRef?: string;
  recovery?: { kind: "legacy_unrecoverable" | "not_found" | "ownership_lost" | "unknown"; evidence: string; observedAt: string };
}

export interface LegacyActiveStep extends ActiveStepBase {
  kind: "legacy";
}

export interface RecoverableActiveStep extends ActiveStepBase {
  kind: "recoverable";
  executionId: string;
  requestKey: string;
}

export type ActiveStep = LegacyActiveStep | RecoverableActiveStep;

export interface WorkflowRun {
  id: string;
  workflowName: string;
  /** Workflow parameters plus anything seed steps merged in. */
  params: Record<string, string>;
  status: WorkflowStatus;
  currentStep: string | null;
  /** Keyed by `stepId:iteration` for dispatches and by `stepId` for seeds and gates. */
  stepResults: Record<string, StepResult>;
  activeSteps: Record<string, ActiveStep>;
  revision: number;
  ownerGeneration: number;
  owner?: WorkflowOwnerLease;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface SeedResult {
  /** Merged into the run's params so later prompts can use it. */
  data: Record<string, string>;
  output?: string;
}

export interface DispatchOptions {
  model?: string;
  /** Extra template variables for this step only. */
  vars?: Record<string, string>;
}

export interface AssistedOptions {
  /** Validates the resolution payload; stored as JSON Schema on the gate. */
  schema?: ZodType;
  expiresAt?: Date | string;
}

/** What a workflow function sees. Every method is memoized, so the function is safe to re-run from the top. */
export interface WorkflowContext {
  readonly runId: string;
  readonly workflowName: string;
  param(key: string): string | undefined;
  /** Render the template, run it through the step runner, parse signals. Retried once on a retryable failure. */
  dispatch(stepId: string, template: string, options?: DispatchOptions): Promise<StepResult>;
  /** Deterministic step without a runner; its data merges into params. */
  seed(stepId: string, fn: () => Promise<SeedResult>): Promise<StepResult>;
  /** Pause on a durable gate until something outside resolves it. */
  assisted(stepId: string, prompt: string, options?: AssistedOptions): Promise<StepResult>;
  /** How many times `stepId` has completed so far; loop guards read this. */
  iteration(stepId: string): number;
  /** Aborts when the run is cancelled; pass it to anything long-running. */
  readonly signal: AbortSignal;
}

export type WorkflowFn = (ctx: WorkflowContext) => Promise<void>;

export interface StepRunInput {
  runId: string;
  workflowName: string;
  stepId: string;
  iteration: number;
  prompt: string;
  model?: string;
  signal: AbortSignal;
}

export type DurableStepOutcome =
  | { kind: "succeeded"; output: string }
  | { kind: "failed"; error: string; retryable: boolean }
  | { kind: "cancelled"; reason: string }
  | { kind: "cancellation_unknown"; reason: string };

export interface RecoverableStepDispatchInput extends StepRunInput {
  executionId: string;
  requestKey: string;
  attempt: number;
}

export interface StepDispatchAck {
  executionId: string;
  requestKey: string;
  runnerRef: string;
  completion: Promise<DurableStepOutcome>;
}

export type StepReconcileOutcome =
  | { kind: "running"; runnerRef: string; completion: Promise<DurableStepOutcome>; evidence: string }
  | { kind: "terminal"; outcome: DurableStepOutcome; evidence: string }
  | { kind: "not_found"; retrySafe: boolean; evidence: string }
  | { kind: "ownership_lost"; evidence: string }
  | { kind: "unknown"; evidence: string };

export type StepRunOutcome =
  | { ok: true; output: string; runnerRef?: string }
  | { ok: false; error: string; retryable: boolean };

/** Where dispatched steps actually execute: an in-process agent, a queue, a subprocess. */
export interface LegacyStepRunner {
  run(input: StepRunInput): Promise<StepRunOutcome>;
  /** @deprecated Prefer RecoverableStepRunner. Undefined or failed attachment requires recovery. */
  attach?(step: ActiveStep, signal: AbortSignal): Promise<StepRunOutcome> | undefined;
}

export interface RecoverableStepRunner {
  dispatch(input: RecoverableStepDispatchInput): Promise<StepDispatchAck>;
  reconcile(step: RecoverableActiveStep, signal: AbortSignal): Promise<StepReconcileOutcome>;
}

export type StepRunner = LegacyStepRunner | RecoverableStepRunner;

export function workflowStepRequestKey(runId: string, stepId: string, iteration: number, attempt: number): string {
  return `workflow:${[runId, stepId, String(iteration), String(attempt)].map(encodeURIComponent).join(":")}`;
}

export type WorkflowEvent =
  | { type: "step_started"; runId: string; stepId: string; iteration: number }
  | { type: "step_complete"; runId: string; stepId: string; iteration: number; signal: string | null }
  | { type: "step_retry"; runId: string; stepId: string; attempt: number; error: string }
  | { type: "step_failed"; runId: string; stepId: string; error: string }
  | { type: "workflow_recovery_required"; runId: string; stepId: string; evidence: string }
  | { type: "gate_opened"; runId: string; stepId: string; gateId: string; prompt: string }
  | { type: "workflow_complete"; runId: string }
  | { type: "workflow_failed"; runId: string; error: string }
  | { type: "workflow_cancelled"; runId: string; reason: string };

export class StepFailedError extends Error {
  constructor(
    readonly stepId: string,
    readonly iteration: number,
    readonly reason: string,
  ) {
    super(`step ${stepId} (iteration ${iteration}) failed: ${reason}`);
    this.name = "StepFailedError";
  }
}

export class WorkflowCancelledError extends Error {
  constructor(
    readonly runId: string,
    readonly reason: string,
  ) {
    super(`workflow ${runId} cancelled: ${reason}`);
    this.name = "WorkflowCancelledError";
  }
}

export class WorkflowRecoveryRequiredError extends Error {
  constructor(
    readonly runId: string,
    readonly stepId: string,
    readonly evidence: string,
  ) {
    super(`workflow ${runId} requires recovery for step ${stepId}: ${evidence}`);
    this.name = "WorkflowRecoveryRequiredError";
  }
}
