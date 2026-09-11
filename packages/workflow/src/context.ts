import { GateAlreadyExists, openGate, waitForGate, type GateStore } from "@titan-design/hitl";
import { nowIso } from "@titan-design/store-sqlite";
import { buildStepVars, type TemplateRenderer } from "./prompt.js";
import type { SignalParser } from "./signals.js";
import {
  StepFailedError,
  WorkflowCancelledError,
  WorkflowRecoveryRequiredError,
  workflowStepRequestKey,
  type ActiveStep,
  type AssistedOptions,
  type DispatchOptions,
  type DurableStepOutcome,
  type RecoverableActiveStep,
  type RecoverableStepRunner,
  type SeedResult,
  type StepResult,
  type StepRunInput,
  type StepRunner,
  type WorkflowContext,
  type WorkflowEvent,
  type WorkflowRun,
} from "./types.js";

export type RecoveredStep =
  | { kind: "completion"; step: ActiveStep; completion: Promise<DurableStepOutcome> }
  | { kind: "retry_safe"; step: RecoverableActiveStep };

export interface ContextDeps {
  gates: GateStore;
  runner: StepRunner;
  render: TemplateRenderer;
  parseSignal: SignalParser;
  emit: (event: WorkflowEvent) => void;
  maxRetries: number;
  gatePollMs: number;
  executionId: () => string;
  save: (run: WorkflowRun) => void;
  recovered: ReadonlyMap<string, RecoveredStep>;
}

export function gateIdFor(runId: string, stepId: string): string {
  return `${runId}/${stepId}`;
}

/** Memoized workflow view. Every mutation is written through the runtime's owner fence. */
export class RunContext implements WorkflowContext {
  readonly runId: string;
  readonly workflowName: string;
  readonly signal: AbortSignal;
  private readonly iterations: Record<string, number> = {};
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    readonly run: WorkflowRun,
    private readonly deps: ContextDeps,
    private readonly controller: AbortController,
  ) {
    this.runId = run.id;
    this.workflowName = run.workflowName;
    this.signal = controller.signal;
  }

  param(key: string): string | undefined {
    return this.run.params[key];
  }

  iteration(stepId: string): number {
    return this.iterations[stepId] ?? 0;
  }

  dispatch(stepId: string, template: string, options: DispatchOptions = {}): Promise<StepResult> {
    const pending = this.dispatchStep(stepId, template, options);
    this.inFlight.add(pending);
    void pending.then(() => this.inFlight.delete(pending), () => this.inFlight.delete(pending));
    return pending;
  }

  async settleDispatches(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private async dispatchStep(stepId: string, template: string, options: DispatchOptions): Promise<StepResult> {
    const iteration = this.iteration(stepId);
    const iterKey = `${stepId}:${iteration}`;
    const cached = this.run.stepResults[iterKey];
    if (cached) return this.bump(stepId, cached);
    const recovered = this.deps.recovered.get(iterKey);
    if (!recovered) this.throwIfCancelled();
    const prompt = await this.deps.render(template, buildStepVars(this.run, options.vars));
    const completed = await this.runWithRetry(stepId, iteration, iterKey, prompt, options.model, recovered);
    const result: StepResult = {
      stepId,
      iteration,
      agentId: completed.runnerRef,
      signal: this.deps.parseSignal(completed.output),
      completedAt: nowIso(),
      output: completed.output,
    };
    delete this.run.activeSteps[stepId];
    this.record(iterKey, result);
    this.deps.emit({ type: "step_complete", runId: this.runId, stepId, iteration, signal: result.signal });
    return this.bump(stepId, result);
  }

  async seed(stepId: string, fn: () => Promise<SeedResult>): Promise<StepResult> {
    this.throwIfCancelled();
    const cached = this.run.stepResults[stepId];
    if (cached) return cached;
    this.setCurrent(stepId);
    const seed = await fn();
    Object.assign(this.run.params, seed.data);
    const result: StepResult = { stepId, iteration: 0, agentId: null, signal: null, completedAt: nowIso(), output: seed.output, data: seed.data };
    this.record(stepId, result);
    this.deps.emit({ type: "step_complete", runId: this.runId, stepId, iteration: 0, signal: null });
    return result;
  }

  async assisted(stepId: string, prompt: string, options: AssistedOptions = {}): Promise<StepResult> {
    this.throwIfCancelled();
    const cached = this.run.stepResults[stepId];
    if (cached) return cached;
    const gateId = gateIdFor(this.runId, stepId);
    this.setCurrent(stepId, "paused");
    this.openGateOnce(gateId, prompt, options, stepId);
    const payload = (await waitForGate(this.deps.gates, gateId, { pollMs: this.deps.gatePollMs, signal: this.signal })) as Record<string, unknown>;
    const signal = typeof payload?.signal === "string" ? payload.signal : null;
    const result: StepResult = { stepId, iteration: 0, agentId: null, signal, completedAt: nowIso(), data: payload ?? undefined };
    this.run.status = "running";
    this.record(stepId, result);
    this.deps.emit({ type: "step_complete", runId: this.runId, stepId, iteration: 0, signal });
    return result;
  }

  private openGateOnce(gateId: string, prompt: string, options: AssistedOptions, stepId: string): void {
    try {
      openGate(this.deps.gates, { id: gateId, prompt, schema: options.schema, expiresAt: options.expiresAt });
      this.deps.emit({ type: "gate_opened", runId: this.runId, stepId, gateId, prompt });
    } catch (error) {
      if (!(error instanceof GateAlreadyExists)) throw error;
    }
  }

  private async runWithRetry(
    stepId: string,
    iteration: number,
    iterKey: string,
    prompt: string,
    model: string | undefined,
    recovered?: RecoveredStep,
  ): Promise<{ output: string; runnerRef: string | null }> {
    let attempt = recovered?.step.attempt ?? 0;
    let pending = recovered?.kind === "completion" ? recovered.completion : undefined;
    let active: ActiveStep | undefined = recovered?.step;
    if (recovered?.kind === "retry_safe") attempt += 1;
    for (;;) {
      if (!pending) {
        active = this.newActiveStep(stepId, iterKey, attempt);
        this.activate(active);
        pending = this.start(active, { runId: this.runId, workflowName: this.workflowName, stepId, iteration, prompt, model, signal: this.signal });
      }
      const outcome = await this.awaitOutcome(active!, pending);
      pending = undefined;
      if (outcome.kind === "succeeded") return { output: outcome.output, runnerRef: active!.runnerRef ?? null };
      if (outcome.kind === "cancelled") {
        this.consumeActive(active!);
        throw new WorkflowCancelledError(this.runId, outcome.reason);
      }
      if (outcome.kind === "cancellation_unknown") this.requireRecovery(active!, "unknown", outcome.reason);
      this.throwIfCancelled();
      const retry = attempt + 1;
      if (!outcome.retryable || attempt >= this.deps.maxRetries) {
        this.consumeActive(active!);
        throw new StepFailedError(stepId, iteration, outcome.error);
      }
      attempt += 1;
      this.deps.emit({ type: "step_retry", runId: this.runId, stepId, attempt: retry, error: outcome.error });
    }
  }

  private newActiveStep(stepId: string, iterKey: string, attempt: number): ActiveStep {
    if (!isRecoverable(this.deps.runner)) return { kind: "legacy", stepId, iterKey, attempt, startedAt: nowIso() };
    const executionId = this.deps.executionId();
    return {
      kind: "recoverable",
      stepId,
      iterKey,
      attempt,
      executionId,
      requestKey: workflowStepRequestKey(this.runId, stepId, Number(iterKey.slice(iterKey.lastIndexOf(":") + 1)), attempt),
      startedAt: nowIso(),
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
      const outcome = await this.deps.runner.run(input);
      if (outcome.ok) {
        if (outcome.runnerRef) step.runnerRef = outcome.runnerRef;
        return { kind: "succeeded", output: outcome.output };
      }
      return { kind: "failed", error: outcome.error, retryable: outcome.retryable };
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
    this.run.status = "recovery_required";
    this.run.error = evidence;
    this.persist();
    this.deps.emit({ type: "workflow_recovery_required", runId: this.runId, stepId: step.stepId, evidence });
    throw new WorkflowRecoveryRequiredError(this.runId, step.stepId, evidence);
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

function isRecoverable(runner: StepRunner): runner is RecoverableStepRunner {
  return "dispatch" in runner && "reconcile" in runner;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
