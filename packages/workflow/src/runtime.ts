import { randomUUID } from "node:crypto";
import { cancelGate, type GateStore } from "@titan-design/hitl";
import { nowIso, type Db } from "@titan-design/store-sqlite";
import { RunContext, gateIdFor, type ContextDeps } from "./context.js";
import { mustacheRenderer, type TemplateRenderer } from "./prompt.js";
import { parseSignal as defaultParseSignal, type SignalParser } from "./signals.js";
import { WorkflowRunStore, newRun } from "./store.js";
import { WorkflowCancelledError, type StepRunner, type WorkflowEvent, type WorkflowFn, type WorkflowRun } from "./types.js";

export interface WorkflowRuntimeOptions {
  db: Db;
  gates: GateStore;
  runner: StepRunner;
  render?: TemplateRenderer;
  parseSignal?: SignalParser;
  onEvent?: (event: WorkflowEvent) => void;
  maxRetries?: number;
  gatePollMs?: number;
  runTable?: string;
}

interface Live {
  ctx: RunContext;
  controller: AbortController;
  done: Promise<void>;
}

class RuntimeShutdown extends Error {
  constructor() {
    super("runtime shutting down");
    this.name = "RuntimeShutdown";
  }
}

/**
 * Owns the registry of workflow functions and the runs in flight. A run is a
 * row plus a re-runnable function: `hydrate()` after a restart replays every
 * unfinished run through its memoized context and picks up where it stopped.
 */
export class WorkflowRuntime {
  private readonly workflows = new Map<string, WorkflowFn>();
  private readonly live = new Map<string, Live>();
  private readonly store: WorkflowRunStore;
  private readonly deps: Omit<ContextDeps, "store"> & { store: WorkflowRunStore };

  constructor(private readonly options: WorkflowRuntimeOptions) {
    this.store = new WorkflowRunStore(options.db, options.runTable);
    this.deps = {
      store: this.store,
      gates: options.gates,
      runner: options.runner,
      render: options.render ?? mustacheRenderer,
      parseSignal: options.parseSignal ?? defaultParseSignal,
      emit: (event) => options.onEvent?.(event),
      maxRetries: options.maxRetries ?? 1,
      gatePollMs: options.gatePollMs ?? 250,
    };
  }

  register(name: string, fn: WorkflowFn): void {
    if (this.workflows.has(name)) throw new Error(`workflow already registered: ${name}`);
    this.workflows.set(name, fn);
  }

  registered(): string[] {
    return [...this.workflows.keys()];
  }

  /** Persist a new run and start executing it. Resolves with the run id immediately. */
  start(name: string, params: Record<string, string> = {}): string {
    const fn = this.workflows.get(name);
    if (!fn) throw new Error(`unknown workflow: ${name}`);
    const run = newRun(randomUUID(), name, params);
    this.store.save(run);
    this.launch(run, fn);
    return run.id;
  }

  /** Resume every running or paused run whose workflow is registered. Returns the ids resumed. */
  async hydrate(): Promise<string[]> {
    const resumed: string[] = [];
    for (const run of this.store.listByStatus(["running", "paused"])) {
      const fn = this.workflows.get(run.workflowName);
      if (!fn || this.live.has(run.id)) continue;
      await this.settleActiveSteps(run);
      this.launch(run, fn);
      resumed.push(run.id);
    }
    return resumed;
  }

  /** Give the runner a chance to re-attach to in-flight work; otherwise the replay re-dispatches it. */
  private async settleActiveSteps(run: WorkflowRun): Promise<void> {
    for (const [stepId, step] of Object.entries(run.activeSteps)) {
      const attached = this.options.runner.attach?.(step, new AbortController().signal);
      const outcome = attached ? await attached : undefined;
      if (outcome?.ok) {
        run.stepResults[step.iterKey] = { stepId, iteration: Number(step.iterKey.split(":").pop()), agentId: step.runnerRef ?? null, signal: this.deps.parseSignal(outcome.output), completedAt: nowIso(), output: outcome.output };
      }
      delete run.activeSteps[stepId];
    }
    this.store.save(run);
  }

  private launch(run: WorkflowRun, fn: WorkflowFn): void {
    const controller = new AbortController();
    const ctx = new RunContext(run, this.deps, controller);
    const done = fn(ctx).then(
      () => this.finish(run, "completed", null),
      (err: unknown) => this.settleRejection(run, controller.signal.reason, err),
    );
    this.live.set(run.id, { ctx, controller, done });
  }

  /** Why the function stopped matters more than what it threw: an abort surfaces as whatever step was mid-flight. */
  private settleRejection(run: WorkflowRun, abortReason: unknown, err: unknown): void {
    if (abortReason instanceof RuntimeShutdown) {
      this.live.delete(run.id);
      return;
    }
    if (abortReason instanceof WorkflowCancelledError) return this.finish(run, "cancelled", abortReason.reason);
    this.finish(run, "failed", err instanceof Error ? err.message : String(err));
  }

  /**
   * Stop driving every live run without changing its row, so another runtime
   * (or this process after a restart) can `hydrate()` it. Does not wait for
   * runners that ignore their abort signal.
   */
  shutdown(): void {
    for (const live of this.live.values()) live.controller.abort(new RuntimeShutdown());
    this.live.clear();
  }

  private finish(run: WorkflowRun, status: "completed" | "failed" | "cancelled", error: string | null): void {
    this.live.delete(run.id);
    run.status = status;
    run.completedAt = nowIso();
    run.error = error;
    run.activeSteps = {};
    this.store.save(run);
    if (status === "completed") this.deps.emit({ type: "workflow_complete", runId: run.id });
    else if (status === "failed") this.deps.emit({ type: "workflow_failed", runId: run.id, error: error ?? "unknown" });
    else this.deps.emit({ type: "workflow_cancelled", runId: run.id, reason: error ?? "cancelled" });
  }

  status(runId: string): WorkflowRun | undefined {
    return this.live.get(runId)?.ctx.run ?? this.store.get(runId);
  }

  list(statuses: WorkflowRun["status"][] = ["running", "paused"]): WorkflowRun[] {
    return this.store.listByStatus(statuses);
  }

  /** Resolves when the run finishes, however it finishes. */
  async wait(runId: string): Promise<WorkflowRun> {
    await this.live.get(runId)?.done;
    const run = this.status(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    return run;
  }

  /** Answer an assisted step from anywhere: a CLI, an MCP tool, a dashboard. */
  signal(runId: string, stepId: string, payload: Record<string, unknown> = {}): void {
    this.options.gates.resolve(gateIdFor(runId, stepId), payload);
  }

  /** Abort the run: the runner's signal fires, pending gates are cancelled, the row is marked cancelled. */
  cancel(runId: string, reason: string): void {
    const live = this.live.get(runId);
    const run = live?.ctx.run ?? this.store.get(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    for (const gate of this.options.gates.listPending()) {
      if (gate.id.startsWith(`${runId}/`)) cancelGate(this.options.gates, gate.id, reason);
    }
    if (live) live.controller.abort(new WorkflowCancelledError(runId, reason));
    else this.finish(run, "cancelled", reason);
  }
}
