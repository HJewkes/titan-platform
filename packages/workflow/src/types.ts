import type { AuthorityRequest } from "@titan-design/authority";
import type { GateRecord, GateResolver } from "@titan-design/hitl";
import type { ZodType } from "zod";

export type WorkflowStatus = "running" | "paused" | "cancelling" | "recovery_required" | "completed" | "failed" | "cancelled";

export interface WorkflowOwnerFence {
  runtimeId: string;
  generation: number;
}

export interface WorkflowOwnerLease extends WorkflowOwnerFence {
  leaseUntil: string;
}

/** What one step cost, as the runner reported it. */
export interface StepUsage {
  costUsd: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Which context method recorded a result; replay compares it to catch a workflow edited under a live run. */
export type StepOperation = "seed" | "dispatch" | "assisted" | "authorize";

export interface StepResult<TData extends Record<string, unknown> = Record<string, unknown>> {
  stepId: string;
  iteration: number;
  /** Absent on results written before 0.5, which replay under the old keys unchecked. */
  operation?: StepOperation;
  /** Runner-assigned id (an agent session id, a job id); null for seed and gate steps. */
  agentId: string | null;
  /** Condition signal parsed from the output, e.g. `needs_revision`. */
  signal: string | null;
  completedAt: string;
  output?: string;
  /** Structured payload: a seed's data, a gate's resolution, or a dispatch's output parsed by its schema. */
  data?: TData;
  /** Summed over every attempt, retries included, when the runner reported cost; `mapItems` sums it against its budget. */
  usage?: StepUsage;
}

export interface ActiveStepBase {
  stepId: string;
  iterKey: string;
  attempt: number;
  startedAt: string;
  runnerRef?: string;
  /** Summed cost of this step's earlier failed attempts, so a resumed run still reports every attempt once. */
  priorUsage?: StepUsage;
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
  /** Keyed by step id and call index: `stepId:n` for dispatches, `stepId` then `stepId:n` for seeds and gates. */
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

export interface DispatchOptions<T = Record<string, unknown>> {
  model?: string;
  /** Extra template variables for this step only. */
  vars?: Record<string, string>;
  /** Parses the output as JSON into `data`; a payload that fails it fails the step without a retry. */
  schema?: ZodType<T>;
}

export interface AssistedOptions {
  /** Validates the resolution payload; stored as JSON Schema on the gate. */
  schema?: ZodType;
  expiresAt?: Date | string;
}

/** An authority request without the actor, which the runtime supplies; `tainted` defaults to false. */
export type AuthorizeRequest = Omit<AuthorityRequest, "actor" | "tainted"> & { tainted?: boolean };

export interface AuthorizeOptions {
  /** Shown to the owner when the table gates the action. */
  prompt?: string;
  expiresAt?: Date | string;
}

/** `allow` came straight from the table; `approved` means an owner answered the rule's gate. */
export interface AuthorizeResult {
  verdict: "allow" | "approved";
  ruleId: string;
  gateId?: string;
  resolvedBy?: GateResolver;
}

/** What a workflow function sees. Every method is memoized, so the function is safe to re-run from the top. */
export interface WorkflowContext {
  readonly runId: string;
  readonly workflowName: string;
  param(key: string): string | undefined;
  /** Render the template, run it through the step runner, parse signals. Retried once on a retryable failure. */
  dispatch<T extends Record<string, unknown> = Record<string, unknown>>(stepId: string, template: string, options?: DispatchOptions<T>): Promise<StepResult<T>>;
  /** Deterministic step without a runner; its data merges into params. */
  seed(stepId: string, fn: () => Promise<SeedResult>): Promise<StepResult>;
  /** Pause on a durable gate until something outside resolves it. */
  assisted(stepId: string, prompt: string, options?: AssistedOptions): Promise<StepResult>;
  /** Ask the authority table: proceed on allow, wait on a rule-bound gate, throw `AuthorityDeniedError` on deny. */
  authorize(stepId: string, request: AuthorizeRequest, options?: AuthorizeOptions): Promise<AuthorizeResult>;
  /** Cancels this run's own pending gates that `isStale` picks, so no one can answer a question the run has moved past; returns their ids. */
  expireGates(reason: string, isStale: (gate: Readonly<GateRecord>) => boolean): string[];
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
  /** The step's schema; a runner may pass it to the model, and the workflow parses the output with it either way. */
  outputSchema?: ZodType;
  signal: AbortSignal;
}

export type DurableStepOutcome =
  | { kind: "succeeded"; output: string; usage?: StepUsage }
  | { kind: "failed"; error: string; retryable: boolean; code?: "schema_invalid"; usage?: StepUsage }
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
  | { ok: true; output: string; runnerRef?: string; usage?: StepUsage }
  | { ok: false; error: string; retryable: boolean; code?: "schema_invalid"; usage?: StepUsage };

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

export interface StepFailureDetail {
  /** The last attempt's failure could clear on a fresh call; `false` means repeating it would fail the same way. */
  retryable?: boolean;
  /** Cost of every failed attempt, when the runner reported it. */
  usage?: StepUsage;
}

export class StepFailedError extends Error {
  readonly retryable: boolean;
  readonly usage: StepUsage | undefined;

  constructor(
    readonly stepId: string,
    readonly iteration: number,
    readonly reason: string,
    detail: StepFailureDetail = {},
  ) {
    super(`step ${stepId} (iteration ${iteration}) failed: ${reason}`);
    this.name = "StepFailedError";
    this.retryable = detail.retryable ?? false;
    this.usage = detail.usage;
  }
}

export type StepOutputFailureKind = "not_json" | "schema" | "too_large";

/** A dispatch whose output failed its schema. Never retryable: the same prompt would produce the same kind of payload. */
export class StepOutputInvalidError extends StepFailedError {
  constructor(
    stepId: string,
    iteration: number,
    readonly kind: StepOutputFailureKind,
    readonly issues: string[],
    usage?: StepUsage,
  ) {
    super(stepId, iteration, `output ${kind}: ${issues.join("; ")}`, { retryable: false, usage });
    this.name = "StepOutputInvalidError";
  }
}

/** The authority table denied the action; no gate was opened, and repeating the request is denied the same way. */
export class AuthorityDeniedError extends StepFailedError {
  constructor(
    stepId: string,
    iteration: number,
    readonly ruleId: string | null,
    readonly denial: string,
  ) {
    super(stepId, iteration, `authority denied: ${denial}`, { retryable: false });
    this.name = "AuthorityDeniedError";
  }
}

/** The rule's gate settled without a valid approval: the owner refused, or the answer's resolver fails the rule. */
export class AuthorityRefusedError extends StepFailedError {
  constructor(
    stepId: string,
    iteration: number,
    readonly ruleId: string,
    readonly gateId: string,
    readonly refusal: string,
  ) {
    super(stepId, iteration, `authority gate ${gateId} refused: ${refusal}`, { retryable: false });
    this.name = "AuthorityRefusedError";
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

export class WorkflowNonDeterminismError extends Error {
  constructor(
    readonly runId: string,
    readonly stepId: string,
    readonly callIndex: number,
    readonly recorded: StepOperation,
    readonly replayed: StepOperation,
  ) {
    super(`workflow ${runId} replayed ${replayed}("${stepId}") at call ${callIndex}, where the run recorded ${recorded}; the workflow changed under a live run`);
    this.name = "WorkflowNonDeterminismError";
  }
}

/** A replayed dispatch whose recorded output no longer satisfies the step's current schema. */
export class WorkflowSchemaDriftError extends Error {
  constructor(
    readonly runId: string,
    readonly stepId: string,
    readonly callIndex: number,
    readonly issues: string[],
  ) {
    super(`workflow ${runId} replayed dispatch("${stepId}") at call ${callIndex}, whose recorded output no longer fits the step schema: ${issues.join("; ")}`);
    this.name = "WorkflowSchemaDriftError";
  }
}
