import { GateAlreadyExists, GateCancelled, openGate, waitForGate, type GateRecord } from "@titan-design/hitl";
import { nowIso } from "@titan-design/store-sqlite";
import type { ZodType } from "zod";
import { authorityOutcome, authorityStepResult, decisionVersion, authorizeResultOf, requireAuthority, type AuthorityGate, type AuthorityOutcome } from "./authorize.js";
import { briefFields } from "./gate-brief.js";
import { assistedGateId, cancelOwnPending, gateIdFor, gateIsPending, memoKey, otherKeyShape, recordedAfter } from "./gate-ids.js";
import type { CompletedStep, ContextDeps, Memo, RecoveredStep } from "./context-deps.js";
import { buildStepVars } from "./prompt.js";
import { isRecoverable, runLegacyStep } from "./recovery.js";
import { messageOf } from "./runtime-values.js";
import { reportingStepFailure } from "./step-failure.js";
import { parseStepOutput } from "./step-output.js";
import { addUsage } from "./usage.js";
import {
  GATE_CANCELLED_SIGNAL,
  StepFailedError,
  StepOutputInvalidError,
  WorkflowCancelledError,
  WorkflowNonDeterminismError,
  WorkflowRecoveryRequiredError,
  WorkflowSchemaDriftError,
  workflowStepRequestKey,
  type ActiveStep,
  type AssistedOptions,
  type AuthorizeOptions,
  type AuthorizeRequest,
  type AuthorizeResult,
  type DispatchOptions,
  type DurableStepOutcome,
  type SeedResult,
  type StepOperation,
  type StepResult,
  type StepRunInput,
  type StepUsage,
  type WorkflowContext,
  type WorkflowRun,
} from "./types.js";

export type { ContextDeps, RecoveredStep } from "./context-deps.js";
export { assistedGateId, gateIdFor, gateIsPending, memoKey, pendingGateId, type GatePredicate } from "./gate-ids.js";


/** Memoized workflow view. Every mutation is written through the runtime's owner fence. */
export class RunContext implements WorkflowContext {
  /** The recorded result the call just made was answered from; undefined when it ran live. */
  private answeredFrom: StepResult | undefined;
  readonly runId: string;
  readonly workflowName: string;
  readonly signal: AbortSignal;
  private readonly iterations: Record<string, number> = {};
  private readonly inFlight = new Set<Promise<unknown>>();
  /** A run with a result from before 0.5 keeps that release's keys: seeds apart from the call count, and no operation check. */
  private readonly legacyKeys: boolean;
  /** The step a resumed run was paused on; its next gate call must find the row it opened. */
  private resumedGateStep: string | null;

  constructor(
    readonly run: WorkflowRun,
    private readonly deps: ContextDeps,
    private readonly controller: AbortController,
  ) {
    this.runId = run.id;
    this.workflowName = run.workflowName;
    this.signal = controller.signal;
    this.legacyKeys = Object.values(run.stepResults).some((result) => result.operation === undefined);
    this.resumedGateStep = run.status === "paused" || run.status === "recovery_required" ? run.currentStep : null;
  }

  param(key: string): string | undefined {
    return this.run.params[key];
  }

  iteration(stepId: string): number {
    return this.iterations[stepId] ?? 0;
  }

  dispatch<T extends Record<string, unknown> = Record<string, unknown>>(stepId: string, template: string, options: DispatchOptions<T> = {}): Promise<StepResult<T>> {
    const pending = reportingStepFailure(this.deps.emit, this.runId, () => this.dispatchStep(stepId, template, options)) as Promise<StepResult<T>>;
    this.inFlight.add(pending);
    void pending.then(() => this.inFlight.delete(pending), () => this.inFlight.delete(pending));
    return pending;
  }

  async settleDispatches(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private async dispatchStep(stepId: string, template: string, options: DispatchOptions<unknown>): Promise<StepResult> {
    const { index: iteration, key: iterKey, cached } = this.recall("dispatch", stepId);
    if (cached) return this.bump(stepId, this.replayed(cached, iteration, options.schema));
    const recovered = this.deps.recovered.get(iterKey);
    if (!recovered) this.throwIfCancelled();
    const prompt = await this.deps.render(template, buildStepVars(this.run, options.vars));
    const completed = await this.runWithRetry(stepId, iteration, iterKey, prompt, options, recovered);
    const data = options.schema ? this.parsedData(stepId, iteration, completed, options.schema) : undefined;
    const result: StepResult = {
      stepId,
      iteration,
      operation: "dispatch",
      agentId: completed.runnerRef,
      signal: this.deps.parseSignal(completed.output),
      completedAt: nowIso(),
      output: completed.output,
      ...(data ? { data } : {}),
      ...(completed.usage ? { usage: completed.usage } : {}),
    };
    delete this.run.activeSteps[stepId];
    this.record(iterKey, result);
    this.deps.emit({ type: "step_complete", runId: this.runId, stepId, iteration, signal: result.signal });
    return this.bump(stepId, result);
  }

  /** Re-derives `data` from the recorded output under the current schema, leaving the stored result as it was. */
  private replayed(cached: StepResult, callIndex: number, schema: ZodType | undefined): StepResult {
    if (!schema) return cached;
    const parsed = parseStepOutput(schema, cached.output ?? "", Number.POSITIVE_INFINITY);
    if (!parsed.ok) throw new WorkflowSchemaDriftError(this.runId, cached.stepId, callIndex, parsed.issues);
    return { ...cached, data: parsed.data };
  }

  /** Parses after the retry loop, so an invalid payload costs one runner call and records no result. */
  private parsedData(stepId: string, iteration: number, completed: CompletedStep, schema: ZodType): Record<string, unknown> {
    const parsed = parseStepOutput(schema, completed.output, this.deps.maxStepDataBytes);
    if (parsed.ok) return parsed.data;
    delete this.run.activeSteps[stepId];
    this.persist();
    throw new StepOutputInvalidError(stepId, iteration, parsed.kind, parsed.issues, completed.usage);
  }

  async seed(stepId: string, fn: () => Promise<SeedResult>): Promise<StepResult> {
    this.throwIfCancelled();
    const { index: iteration, key, cached } = this.recall("seed", stepId);
    if (cached) return this.bumpSeed(stepId, cached);
    this.setCurrent(stepId);
    const seed = await fn();
    Object.assign(this.run.params, seed.data);
    const result: StepResult = {
      stepId,
      iteration,
      operation: "seed",
      agentId: null,
      signal: null,
      completedAt: nowIso(),
      output: seed.output,
      data: seed.data,
    };
    this.record(key, result);
    this.deps.emit({ type: "step_complete", runId: this.runId, stepId, iteration, signal: null });
    return this.bumpSeed(stepId, result);
  }

  async assisted(stepId: string, prompt: string, options: AssistedOptions = {}): Promise<StepResult> {
    this.throwIfCancelled();
    const { index: iteration, key, cached } = this.recall("assisted", stepId);
    if (cached) return this.bump(stepId, cached);
    const gateId = assistedGateId(this.run, stepId, iteration, (id) => gateIsPending(this.deps.gates, id));
    this.requireResumedGate(stepId, gateId);
    this.openGateOnce(gateId, prompt, options, stepId);
    this.setCurrent(stepId, "paused");
    const payload = await this.gatePayload(gateId, options.recordCancel === true);
    const signal = typeof payload?.signal === "string" ? payload.signal : null;
    const result: StepResult = { stepId, iteration, operation: "assisted", agentId: null, signal, completedAt: nowIso(), data: payload ?? undefined };
    this.run.status = "running";
    this.record(key, result);
    this.deps.emit({ type: "step_complete", runId: this.runId, stepId, iteration, signal });
    return this.bump(stepId, result);
  }

  /** Under `recordCancel` a cancel is the gate's answer; a cancelled run still aborts the wait first. */
  private async gatePayload(gateId: string, recordCancel: boolean): Promise<Record<string, unknown>> {
    try {
      return (await waitForGate(this.deps.gates, gateId, { pollMs: this.deps.gatePollMs, signal: this.signal })) as Record<string, unknown>;
    } catch (error) {
      if (!recordCancel || !(error instanceof GateCancelled)) throw error;
      return { signal: GATE_CANCELLED_SIGNAL, reason: error.reason };
    }
  }

  /** A no-op while the call just made was answered from the record: replay re-runs old callbacks, and a side effect there would hit gates the run still waits on. */
  expireGates(reason: string, isStale: (gate: Readonly<GateRecord>) => boolean): string[] {
    return this.answeredFrom !== undefined ? [] : cancelOwnPending(this.deps.gates, this.runId, reason, isStale);
  }

  historyNext(): string | undefined { return recordedAfter(this.run.stepResults, this.answeredFrom); }

  resumedGate(): string | undefined { return this.resumedGateStep ?? undefined; }

  /** A paused run already opened this gate, so a missing row is lost history: reopening it would ask the step again. */
  private requireResumedGate(stepId: string, gateId: string): void {
    if (this.resumedGateStep !== stepId) return;
    this.resumedGateStep = null;
    if (!this.deps.gates.get(gateId)) this.holdForRecovery(stepId, `gate ${gateId} is missing, but the run was paused on it`, gateId);
  }

  private openGateOnce(gateId: string, prompt: string, options: AssistedOptions, stepId: string): void {
    try {
      openGate(this.deps.gates, { ...briefFields(options.brief), id: gateId, prompt, schema: options.schema, expiresAt: options.expiresAt });
      this.emitGateOpened(stepId, gateId, prompt, options.brief?.summary);
    } catch (error) {
      if (!(error instanceof GateAlreadyExists)) throw error;
    }
  }

  private emitGateOpened(stepId: string, gateId: string, prompt: string, summary: string | undefined): void {
    this.deps.emit({ type: "gate_opened", runId: this.runId, stepId, gateId, prompt, ...(summary === undefined ? {} : { summary }) });
  }

  authorize(stepId: string, request: AuthorizeRequest, options: AuthorizeOptions = {}): Promise<AuthorizeResult> {
    return reportingStepFailure(this.deps.emit, this.runId, () => this.authorizeStep(stepId, request, options));
  }

  private async authorizeStep(stepId: string, request: AuthorizeRequest, options: AuthorizeOptions): Promise<AuthorizeResult> {
    this.throwIfCancelled();
    const { index: iteration, key, cached } = this.recall("authorize", stepId);
    if (cached) return authorizeResultOf(stepId, iteration, this.bump(stepId, cached).data as AuthorityOutcome);
    const gateId = gateIdFor(this.runId, key);
    this.requireResumedGate(stepId, gateId);
    const gate: AuthorityGate = {
      id: gateId,
      store: this.deps.gates,
      wait: { pollMs: this.deps.gatePollMs, signal: this.signal },
      opened: (gateId, prompt, summary) => this.emitGateOpened(stepId, gateId, prompt, summary),
      paused: () => this.setCurrent(stepId, "paused"),
    };
    const authority = requireAuthority(this.deps.authority, stepId);
    const outcome = await authorityOutcome(authority, gate, request, options);
    const result = authorityStepResult(this.runId, stepId, iteration, outcome, decisionVersion(outcome, this.deps.gates, authority));
    if (this.run.status === "paused") this.run.status = "running";
    this.record(key, result);
    this.deps.emit({ type: "step_complete", runId: this.runId, stepId, iteration, signal: null });
    return authorizeResultOf(stepId, iteration, this.bump(stepId, result).data as AuthorityOutcome);
  }

  private async runWithRetry(
    stepId: string,
    iteration: number,
    iterKey: string,
    prompt: string,
    options: DispatchOptions<unknown>,
    recovered?: RecoveredStep,
  ): Promise<CompletedStep> {
    let attempt = recovered?.step.attempt ?? 0;
    let pending = recovered?.kind === "completion" ? recovered.completion : undefined;
    let active: ActiveStep | undefined = recovered?.step;
    let failedUsage = recovered?.step.priorUsage;
    if (recovered?.kind === "retry_safe") attempt += 1;
    for (;;) {
      if (!pending) {
        active = this.newActiveStep(stepId, iterKey, attempt, failedUsage);
        this.activate(active);
        pending = this.start(active, { runId: this.runId, workflowName: this.workflowName, stepId, iteration, prompt, model: options.model, outputSchema: options.schema, signal: this.signal });
      }
      const outcome = await this.awaitOutcome(active!, pending);
      pending = undefined;
      if (outcome.kind === "succeeded") return { output: outcome.output, runnerRef: active!.runnerRef ?? null, usage: addUsage(failedUsage, outcome.usage) };
      if (outcome.kind === "cancelled") {
        this.consumeActive(active!);
        throw new WorkflowCancelledError(this.runId, outcome.reason);
      }
      if (outcome.kind === "cancellation_unknown") this.requireRecovery(active!, "unknown", outcome.reason);
      this.throwIfCancelled();
      const retry = attempt + 1;
      failedUsage = addUsage(failedUsage, outcome.usage);
      if (outcome.code === "schema_invalid") {
        this.consumeActive(active!);
        throw new StepOutputInvalidError(stepId, iteration, "schema", [outcome.error], failedUsage);
      }
      if (!outcome.retryable || attempt >= this.deps.maxRetries) {
        this.consumeActive(active!);
        throw new StepFailedError(stepId, iteration, outcome.error, { retryable: outcome.retryable, usage: failedUsage });
      }
      attempt += 1;
      this.deps.emit({ type: "step_retry", runId: this.runId, stepId, attempt: retry, error: outcome.error });
    }
  }

  private newActiveStep(stepId: string, iterKey: string, attempt: number, priorUsage: StepUsage | undefined): ActiveStep {
    const base = { stepId, iterKey, attempt, startedAt: nowIso(), ...(priorUsage ? { priorUsage } : {}) };
    if (!isRecoverable(this.deps.runner)) return { kind: "legacy", ...base };
    const executionId = this.deps.executionId();
    return {
      kind: "recoverable",
      ...base,
      executionId,
      requestKey: workflowStepRequestKey(this.runId, stepId, Number(iterKey.slice(iterKey.lastIndexOf(":") + 1)), attempt),
    };
  }

  private activate(step: ActiveStep): void {
    this.run.currentStep = step.stepId;
    if (this.run.status !== "cancelling") this.run.status = "running";
    this.run.activeSteps[step.stepId] = step;
    this.persist();
    this.deps.emit({ type: "step_started", runId: this.runId, stepId: step.stepId, iteration: Number(step.iterKey.slice(step.iterKey.lastIndexOf(":") + 1)) });
  }

  private async start(step: ActiveStep, input: StepRunInput): Promise<DurableStepOutcome> {
    if (step.kind === "legacy") {
      if (isRecoverable(this.deps.runner)) return this.requireRecovery(step, "unknown", "legacy step has no legacy runner");
      return runLegacyStep(this.deps.runner, step, input);
    }
    if (!isRecoverable(this.deps.runner)) return this.requireRecovery(step, "unknown", "recoverable step has no recoverable runner");
    const ack = await this.deps.runner.dispatch({ ...input, executionId: step.executionId, requestKey: step.requestKey, attempt: step.attempt });
    void ack.completion.catch(() => undefined);
    if (ack.executionId !== step.executionId || ack.requestKey !== step.requestKey || !ack.runnerRef.trim()) {
      return this.requireRecovery(step, "unknown", "runner acknowledgment does not match the persisted execution intent");
    }
    step.runnerRef = ack.runnerRef;
    this.persist();
    return ack.completion;
  }

  private async awaitOutcome(step: ActiveStep, outcome: Promise<DurableStepOutcome>): Promise<DurableStepOutcome> {
    try {
      return await outcome;
    } catch (error) {
      return this.requireRecovery(step, "unknown", `durable completion rejected: ${messageOf(error)}`);
    }
  }

  private requireRecovery(step: ActiveStep, kind: NonNullable<ActiveStep["recovery"]>["kind"], evidence: string): never {
    step.recovery = { kind, evidence, observedAt: nowIso() };
    return this.holdForRecovery(step.stepId, evidence);
  }

  private holdForRecovery(stepId: string, evidence: string, gateId?: string): never {
    this.run.status = "recovery_required";
    this.run.error = evidence;
    this.persist();
    this.deps.emit({ type: "workflow_recovery_required", runId: this.runId, stepId, evidence, ...(gateId ? { gateId } : {}) });
    throw new WorkflowRecoveryRequiredError(this.runId, stepId, evidence);
  }

  /** Finds what this call position recorded, and refuses a replay that reaches it through a different method. */
  private recall(operation: StepOperation, stepId: string): Memo {
    const index = this.legacyKeys && operation === "seed" ? 0 : this.iteration(stepId);
    const key = memoKey(operation, stepId, index);
    const cached = this.run.stepResults[key] ?? (this.legacyKeys ? undefined : this.run.stepResults[memoKey(otherKeyShape(operation), stepId, index)]);
    if (!this.legacyKeys && cached?.operation && cached.operation !== operation) {
      throw new WorkflowNonDeterminismError(this.runId, stepId, index, cached.operation, operation);
    }
    this.answeredFrom = cached;
    return { index, key, cached };
  }

  private bumpSeed(stepId: string, result: StepResult): StepResult {
    return this.legacyKeys ? result : this.bump(stepId, result);
  }

  private bump(stepId: string, result: StepResult): StepResult {
    this.iterations[stepId] = (this.iterations[stepId] ?? 0) + 1;
    return result;
  }

  private consumeActive(step: ActiveStep): void {
    delete this.run.activeSteps[step.stepId];
    this.persist();
  }

  private setCurrent(stepId: string, status: WorkflowRun["status"] = "running"): void {
    this.run.currentStep = stepId;
    this.run.status = status;
    this.persist();
  }

  private record(key: string, result: StepResult): void {
    this.run.stepResults[key] = result;
    this.persist();
  }

  private throwIfCancelled(): void {
    if (this.signal.aborted) throw new WorkflowCancelledError(this.runId, String(this.signal.reason ?? "cancelled"));
  }

  private persist(): void {
    this.deps.save(this.run);
  }
}
