import { GateAlreadyExists, openGate, waitForGate, type GateStore } from "@titan-design/hitl";
import { nowIso } from "@titan-design/store-sqlite";
import { buildStepVars, type TemplateRenderer } from "./prompt.js";
import type { SignalParser } from "./signals.js";
import type { WorkflowRunStore } from "./store.js";
import {
  StepFailedError,
  WorkflowCancelledError,
  type AssistedOptions,
  type DispatchOptions,
  type SeedResult,
  type StepResult,
  type StepRunner,
  type WorkflowContext,
  type WorkflowEvent,
  type WorkflowRun,
} from "./types.js";

export interface ContextDeps {
  store: WorkflowRunStore;
  gates: GateStore;
  runner: StepRunner;
  render: TemplateRenderer;
  parseSignal: SignalParser;
  emit: (event: WorkflowEvent) => void;
  /** Automatic re-dispatches after a retryable runner failure. */
  maxRetries: number;
  gatePollMs: number;
}

export function gateIdFor(runId: string, stepId: string): string {
  return `${runId}/${stepId}`;
}

/**
 * The memoized view of one run. The workflow function re-runs from the top
 * after a restart; every completed step returns its stored result instead of
 * doing the work again, so execution resumes exactly where it stopped.
 */
export class RunContext implements WorkflowContext {
  readonly runId: string;
  readonly workflowName: string;
  readonly signal: AbortSignal;
  private readonly iterations: Record<string, number> = {};
  private readonly retries = new Map<string, number>();

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

  async dispatch(stepId: string, template: string, options: DispatchOptions = {}): Promise<StepResult> {
    this.throwIfCancelled();
    const iteration = this.iteration(stepId);
    const iterKey = `${stepId}:${iteration}`;
    const cached = this.run.stepResults[iterKey];
    if (cached) return this.bump(stepId, cached);
    const prompt = await this.deps.render(template, buildStepVars(this.run, options.vars));
    const output = await this.runWithRetry(stepId, iteration, iterKey, prompt, options.model);
    const result: StepResult = { stepId, iteration, agentId: this.run.activeSteps[stepId]?.runnerRef ?? null, signal: this.deps.parseSignal(output), completedAt: nowIso(), output };
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

  /** A gate row survives restarts, so re-opening after replay must be a no-op. */
  private openGateOnce(gateId: string, prompt: string, options: AssistedOptions, stepId: string): void {
    try {
      openGate(this.deps.gates, { id: gateId, prompt, schema: options.schema, expiresAt: options.expiresAt });
      this.deps.emit({ type: "gate_opened", runId: this.runId, stepId, gateId, prompt });
    } catch (err) {
      if (!(err instanceof GateAlreadyExists)) throw err;
    }
  }

  private async runWithRetry(stepId: string, iteration: number, iterKey: string, prompt: string, model: string | undefined): Promise<string> {
    for (;;) {
      this.setCurrent(stepId);
      this.run.activeSteps[stepId] = { stepId, iterKey, startedAt: nowIso() };
      this.persist();
      this.deps.emit({ type: "step_started", runId: this.runId, stepId, iteration });
      const outcome = await this.deps.runner.run({ runId: this.runId, workflowName: this.workflowName, stepId, iteration, prompt, model, signal: this.signal });
      if (outcome.ok) {
        if (outcome.runnerRef) this.run.activeSteps[stepId]!.runnerRef = outcome.runnerRef;
        return outcome.output;
      }
      this.throwIfCancelled();
      const attempt = (this.retries.get(iterKey) ?? 0) + 1;
      if (!outcome.retryable || attempt > this.deps.maxRetries) {
        delete this.run.activeSteps[stepId];
        this.persist();
        this.deps.emit({ type: "step_failed", runId: this.runId, stepId, error: outcome.error });
        throw new StepFailedError(stepId, iteration, outcome.error);
      }
      this.retries.set(iterKey, attempt);
      this.deps.emit({ type: "step_retry", runId: this.runId, stepId, attempt, error: outcome.error });
    }
  }

  private bump(stepId: string, result: StepResult): StepResult {
    this.iterations[stepId] = (this.iterations[stepId] ?? 0) + 1;
    return result;
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

  persist(): void {
    this.deps.store.save(this.run);
  }
}
