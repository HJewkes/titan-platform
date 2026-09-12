import { randomUUID } from "node:crypto";
import { cancelGate } from "@titan-design/hitl";
import { RunContext, gateIdFor, type ContextDeps, type RecoveredStep } from "./context.js";
import { mustacheRenderer } from "./prompt.js";
import { markStepRecovery, reconcileActiveSteps } from "./recovery.js";
import type { WorkflowRuntimeOptions } from "./runtime-options.js";
import { fenceOf, messageOf, positiveDuration, RuntimeShutdown, sameFence, timestampAt, WorkflowPersistenceError } from "./runtime-values.js";
import { parseSignal as defaultParseSignal } from "./signals.js";
import { WorkflowOwnershipLostError, WorkflowRunStore, newRun } from "./store.js";
import {
  WorkflowCancelledError,
  WorkflowRecoveryRequiredError,
  type ActiveStep,
  type WorkflowFn,
  type WorkflowRun,
} from "./types.js";

interface Live {
  ctx: RunContext;
  controller: AbortController;
  done: Promise<void>;
  renewTimer: ReturnType<typeof setInterval>;
}

/** Durable workflow driver with fenced row ownership and explicit execution reconciliation. */
export class WorkflowRuntime {
  private readonly workflows = new Map<string, WorkflowFn>();
  private readonly live = new Map<string, Live>();
  private readonly store: WorkflowRunStore;
  private readonly runtimeId: string;
  private readonly leaseMs: number;
  private readonly reconcileTimeoutMs: number;
  private readonly now: () => number;
  private readonly baseDeps: Omit<ContextDeps, "save" | "recovered">;

  constructor(private readonly options: WorkflowRuntimeOptions) {
    this.store = new WorkflowRunStore(options.db, options.runTable);
    this.runtimeId = options.runtimeId ?? randomUUID();
    this.leaseMs = positiveDuration(options.leaseMs ?? 30_000, "leaseMs");
    this.reconcileTimeoutMs = positiveDuration(options.reconcileTimeoutMs ?? 30_000, "reconcileTimeoutMs");
    this.now = options.now ?? Date.now;
    this.baseDeps = {
      gates: options.gates,
      runner: options.runner,
      render: options.render ?? mustacheRenderer,
      parseSignal: options.parseSignal ?? defaultParseSignal,
      emit: (event) => options.onEvent?.(event),
      maxRetries: options.maxRetries ?? 1,
      gatePollMs: options.gatePollMs ?? 250,
      executionId: options.executionId ?? randomUUID,
    };
  }

  register(name: string, fn: WorkflowFn): void {
    if (this.workflows.has(name)) throw new Error(`workflow already registered: ${name}`);
    this.workflows.set(name, fn);
  }

  registered(): string[] {
    return [...this.workflows.keys()];
  }
  start(name: string, params: Record<string, string> = {}): string {
    const fn = this.workflows.get(name);
    if (!fn) throw new Error(`unknown workflow: ${name}`);
    const run = newRun(randomUUID(), name, params);
    this.store.create(run);
    const claimed = this.claim(run.id);
    if (!claimed) throw new Error(`could not claim new workflow ${run.id}`);
    this.launch(claimed, fn, new Map());
    return run.id;
  }

  async hydrate(): Promise<string[]> {
    const candidates = this.store.listByStatus(["running", "paused", "cancelling", "recovery_required"]);
    const settled = await Promise.allSettled(candidates.map((run) => this.hydrateOne(run)));
    return settled.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
  }

  private async hydrateOne(snapshot: WorkflowRun): Promise<string | null> {
    if (this.live.has(snapshot.id)) return null;
    const fn = this.workflows.get(snapshot.workflowName);
    if (!fn) return null;
    const run = this.claim(snapshot.id);
    if (!run) return null;
    const controller = new AbortController();
    const renewTimer = this.startRenewal(run, controller);
    if (run.status === "cancelling") controller.abort(new WorkflowCancelledError(run.id, run.error ?? "cancelled"));
    try {
      const recovered = await this.reconcile(run, controller.signal);
      if (!recovered) {
        clearInterval(renewTimer);
        this.release(run);
        return null;
      }
      this.launch(run, fn, recovered, controller, renewTimer);
      return run.id;
    } catch (error) {
      clearInterval(renewTimer);
      if (error instanceof WorkflowOwnershipLostError) this.release(run);
      else this.parkHydrationFailure(run, error);
      return null;
    }
  }

  private async reconcile(run: WorkflowRun, signal: AbortSignal): Promise<Map<string, RecoveredStep> | null> {
    const recovered = await reconcileActiveSteps(run, {
      runner: this.options.runner,
      signal,
      timeoutMs: this.reconcileTimeoutMs,
      now: () => this.isoNow(),
      emit: this.baseDeps.emit,
    });
    this.save(run);
    return recovered;
  }

  private markRecovery(run: WorkflowRun, step: ActiveStep, kind: NonNullable<ActiveStep["recovery"]>["kind"], evidence: string): true {
    markStepRecovery(step, kind, evidence, this.isoNow());
    run.status = "recovery_required";
    run.error = evidence;
    this.baseDeps.emit({ type: "workflow_recovery_required", runId: run.id, stepId: step.stepId, evidence });
    return true;
  }

  private launch(
    run: WorkflowRun,
    fn: WorkflowFn,
    recovered: ReadonlyMap<string, RecoveredStep>,
    controller = new AbortController(),
    renewTimer = this.startRenewal(run, controller),
  ): void {
    const deps: ContextDeps = { ...this.baseDeps, recovered, save: (value) => this.save(value) };
    const ctx = new RunContext(run, deps, controller);
    const done = this.drive(run, fn, ctx, controller);
    this.live.set(run.id, { ctx, controller, done, renewTimer });
  }

  private async drive(run: WorkflowRun, fn: WorkflowFn, ctx: RunContext, controller: AbortController): Promise<void> {
    let failure: unknown;
    let rejected = false;
    try {
      await fn(ctx);
    } catch (error) {
      failure = error;
      rejected = true;
    }
    await ctx.settleDispatches();
    try {
      if (rejected) this.settleRejection(run, controller.signal.reason, failure);
      else this.finishFromSuccess(run, controller.signal.reason);
    } catch (error) {
      this.settleRejection(run, controller.signal.reason, error);
    }
  }

  private finishFromSuccess(run: WorkflowRun, abortReason: unknown): void {
    if (abortReason instanceof RuntimeShutdown || abortReason instanceof WorkflowOwnershipLostError) return this.dropLive(run.id);
    const unfinished = Object.values(run.activeSteps)[0];
    if (unfinished) {
      const evidence = `workflow returned while step ${unfinished.stepId} still required reconciliation`;
      this.markRecovery(run, unfinished, "unknown", evidence);
      this.save(run);
      return this.park(run);
    }
    if (run.status === "recovery_required") return this.park(run);
    if (abortReason instanceof WorkflowCancelledError || run.status === "cancelling") {
      return this.finish(run, "cancelled", abortReason instanceof WorkflowCancelledError ? abortReason.reason : run.error);
    }
    this.finish(run, "completed", null);
  }

  private settleRejection(run: WorkflowRun, abortReason: unknown, error: unknown): void {
    if (
      abortReason instanceof RuntimeShutdown ||
      abortReason instanceof WorkflowOwnershipLostError ||
      error instanceof WorkflowOwnershipLostError
    ) return this.dropLive(run.id);
    if (error instanceof WorkflowPersistenceError) return this.parkPersistenceFailure(run, error);
    if (error instanceof WorkflowRecoveryRequiredError || run.status === "recovery_required") return this.park(run);
    if (abortReason instanceof WorkflowCancelledError) return this.finish(run, "cancelled", abortReason.reason);
    if (error instanceof WorkflowCancelledError) return this.finish(run, "cancelled", error.reason);
    this.finish(run, "failed", messageOf(error));
  }

  shutdown(): void {
    for (const live of this.live.values()) {
      clearInterval(live.renewTimer);
      live.controller.abort(new RuntimeShutdown());
      this.release(live.ctx.run);
    }
    this.live.clear();
  }

  private finish(run: WorkflowRun, status: "completed" | "failed" | "cancelled", error: string | null): void {
    this.dropLive(run.id);
    run.status = status;
    run.completedAt = this.isoNow();
    run.error = error;
    run.activeSteps = {};
    this.save(run);
    this.release(run);
    if (status === "completed") this.baseDeps.emit({ type: "workflow_complete", runId: run.id });
    else if (status === "failed") this.baseDeps.emit({ type: "workflow_failed", runId: run.id, error: error ?? "unknown" });
    else this.baseDeps.emit({ type: "workflow_cancelled", runId: run.id, reason: error ?? "cancelled" });
  }

  status(runId: string): WorkflowRun | undefined {
    return this.live.get(runId)?.ctx.run ?? this.store.get(runId);
  }
  list(statuses: WorkflowRun["status"][] = ["running", "paused", "cancelling", "recovery_required"]): WorkflowRun[] {
    return this.store.listByStatus(statuses);
  }

  async wait(runId: string): Promise<WorkflowRun> {
    await this.live.get(runId)?.done;
    const run = this.status(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    return run;
  }

  signal(runId: string, stepId: string, payload: Record<string, unknown> = {}): void {
    this.options.gates.resolve(gateIdFor(runId, stepId), payload);
  }
  cancel(runId: string, reason: string): void {
    const live = this.live.get(runId);
    const run = live?.ctx.run ?? this.claim(runId);
    if (!run) {
      const current = this.store.get(runId);
      if (current && isTerminal(current.status)) return;
      throw new Error(`workflow ${runId} is owned by another runtime or does not exist`);
    }
    run.status = "cancelling";
    run.error = reason;
    this.save(run);
    this.cancelGates(runId, reason);
    if (live) live.controller.abort(new WorkflowCancelledError(runId, reason));
    else if (Object.keys(run.activeSteps).length === 0) this.finish(run, "cancelled", reason);
    else this.release(run);
  }

  private cancelGates(runId: string, reason: string): void {
    for (const gate of this.options.gates.listPending()) {
      if (gate.id.startsWith(`${runId}/`)) cancelGate(this.options.gates, gate.id, reason);
    }
  }

  private startRenewal(run: WorkflowRun, controller: AbortController): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      try {
        const lease = this.leaseWindow();
        this.store.renew(run, fenceOf(run), lease.leaseUntil, lease.at);
      } catch (error) {
        clearInterval(timer);
        controller.abort(error);
      }
    }, Math.max(1, Math.floor(this.leaseMs / 3)));
    timer.unref?.();
    return timer;
  }

  private claim(runId: string): WorkflowRun | undefined {
    const lease = this.leaseWindow();
    return this.store.claim(runId, this.runtimeId, lease.leaseUntil, lease.at);
  }

  private save(run: WorkflowRun): void {
    try {
      const lease = this.leaseWindow();
      this.store.save(run, fenceOf(run), lease.leaseUntil, lease.at);
    } catch (error) {
      if (error instanceof WorkflowOwnershipLostError) throw error;
      throw new WorkflowPersistenceError(run.id, error);
    }
  }

  private release(run: WorkflowRun): void {
    try {
      this.store.release(run, fenceOf(run));
    } catch (error) {
      if (!(error instanceof WorkflowOwnershipLostError)) throw error;
    }
  }

  private dropLive(runId: string): void {
    const live = this.live.get(runId);
    if (live) clearInterval(live.renewTimer);
    this.live.delete(runId);
  }

  private park(run: WorkflowRun): void {
    this.dropLive(run.id);
    this.release(run);
  }

  private parkHydrationFailure(run: WorkflowRun, error: unknown): void {
    const step = Object.values(run.activeSteps)[0];
    if (step) this.markRecovery(run, step, "unknown", `hydrate failed: ${messageOf(error)}`);
    try {
      this.save(run);
    } catch {
      // The authoritative row retains the active intent when persistence remains unavailable.
    }
    this.park(run);
  }

  private parkPersistenceFailure(run: WorkflowRun, failure: WorkflowPersistenceError): void {
    this.dropLive(run.id);
    const originalFence = run.owner && fenceOf(run);
    const authoritative = this.store.get(run.id);
    const step = authoritative && Object.values(authoritative.activeSteps)[0];
    if (!originalFence || !authoritative?.owner || !sameFence(authoritative.owner, originalFence)) return;
    if (step) this.markRecovery(authoritative, step, "unknown", failure.message);
    else {
      authoritative.status = "recovery_required";
      authoritative.error = failure.message;
    }
    try {
      const lease = this.leaseWindow();
      this.store.save(authoritative, originalFence, lease.leaseUntil, lease.at);
    } catch {
      // A later owner can reconcile the unchanged active intent.
    }
    try {
      this.store.release(authoritative, originalFence);
    } catch (error) {
      if (!(error instanceof WorkflowOwnershipLostError)) throw error;
    }
  }

  private leaseWindow(): { leaseUntil: string; at: string } {
    const at = this.now();
    return { leaseUntil: timestampAt(at + this.leaseMs, "lease expiration"), at: timestampAt(at, "now") };
  }

  private isoNow(): string {
    return timestampAt(this.now(), "now");
  }
}

function isTerminal(status: WorkflowRun["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
