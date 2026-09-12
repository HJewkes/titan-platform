import { randomUUID } from "node:crypto";
import {
  isTerminalExecutionPhase,
  type ExecutionOwnerFence,
  type ExecutionRecord,
  type ExecutionTerminal,
  type ExecutionTransition,
} from "@titan-design/agent-protocol";
import type { Harness, HarnessRunProgress, HarnessRunResult } from "./harness-contracts.js";
import { terminalFromHarnessResult } from "./durable-result.js";
import type {
  DurableCancelResult,
  DurableDispatchAck,
  DurableDispatchInput,
  DurableHarnessDispatcher,
  DurableHarnessDispatcherDeps,
  DurableHarnessDispatcherOptions,
  DurableHarnessRecord,
  DurableHarnessSuccess,
  DurableReconcileOutcome,
  DurableSettlement,
} from "./durable-types.js";
import {
  failureKind,
  message,
  nonempty,
  ownsLiveFence,
  positive,
  raceLiveResult,
  readLedgerRecord,
  recordFence,
  startLiveExecution,
  type LiveExecution,
  type StoredSuccess,
  type TransitionFields,
  validateDispatchInput,
} from "./durable-dispatcher-support.js";
import { claimForRecovery, closePrepared, reconcileLive, requireRecovery } from "./durable-reconcile.js";

export function createDurableHarnessDispatcher<H extends Harness>(
  adapter: DurableHarnessDispatcher<H>["adapter"],
  options: DurableHarnessDispatcherOptions<H>,
  deps: DurableHarnessDispatcherDeps = {},
): DurableHarnessDispatcher<H> {
  return new Dispatcher(adapter, options, deps);
}
class Dispatcher<H extends Harness> implements DurableHarnessDispatcher<H> {
  private readonly live = new Map<string, LiveExecution<H>>();
  private readonly eventId: () => string;
  private readonly now: () => number;
  private readonly schedule: typeof globalThis.setInterval;
  private readonly unschedule: typeof globalThis.clearInterval;
  private readonly renewEveryMs: number;

  constructor(
    readonly adapter: DurableHarnessDispatcher<H>["adapter"],
    private readonly options: DurableHarnessDispatcherOptions<H>,
    deps: DurableHarnessDispatcherDeps,
  ) {
    nonempty("supervisorId", options.supervisorId);
    positive("leaseMs", options.leaseMs);
    this.renewEveryMs = options.renewEveryMs ?? Math.max(1, Math.floor(options.leaseMs / 3));
    positive("renewEveryMs", this.renewEveryMs);
    if (this.renewEveryMs >= options.leaseMs) throw new TypeError("renewEveryMs must be less than leaseMs");
    this.eventId = deps.eventId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.schedule = deps.setInterval ?? globalThis.setInterval;
    this.unschedule = deps.clearInterval ?? globalThis.clearInterval;
  }
  async dispatch<T>(input: DurableDispatchInput<H, T>): Promise<DurableDispatchAck<T, H>> {
    validateDispatchInput(input, this.adapter.descriptor.harness);
    const prepared = this.prepare(input);
    if (input.request.signal?.aborted) return this.preCancelled(input, prepared);
    this.apply(input.executionId, {
      kind: "begin_dispatch",
      fence: recordFence(prepared),
    });

    const controller = new AbortController();
    const live = this.startLive(input.executionId, recordFence(prepared), controller, input.request.signal);
    this.live.set(input.executionId, live);
    const completion = this.runAdapter(input, live);
    live.completion = completion as Promise<DurableSettlement<unknown, H>>;
    completion.catch(() => undefined);
    return { executionId: input.executionId, requestKey: input.requestKey, runnerRef: input.executionId, completion };
  }
  async reconcile(executionId: string): Promise<DurableReconcileOutcome<H>> {
    nonempty("executionId", executionId);
    const active = this.live.get(executionId);
    if (active) return reconcileLive(this.options.ledger, executionId, active, this.now(), (evidence) => this.failLive(active, "ownership_lost", evidence));
    const read = readLedgerRecord(this.options.ledger, executionId);
    if (!read.ok) return { kind: "ownership_lost", evidence: read.evidence };
    const current = read.record;
    if (!current) return { kind: "unknown", evidence: "execution ledger has no durable receipt; native submission cannot be excluded" };
    if (current.terminal) return { kind: "terminal", terminal: current.terminal, evidence: "terminal execution ledger receipt" };

    const claimed = claimForRecovery(
      current,
      { now: this.now(), supervisorId: this.options.supervisorId, leaseUntil: this.leaseUntil() },
      (record, fields) => this.tryApply(record, fields),
    );
    if (!claimed.ok) return { kind: "ownership_lost", evidence: claimed.evidence };
    if (claimed.record.phase === "prepared") {
      return closePrepared(claimed.record, (record, fields) => this.tryApply(record, fields));
    }
    if (claimed.record.phase !== "recovery_required") {
      const recovered = requireRecovery(claimed.record, recordFence(claimed.record), "dispatcher restarted without a transport attachment handle", (record, fields) => this.tryApply(record, fields));
      if (recovered.kind === "ownership_lost") return recovered;
      if (recovered.kind === "terminal") return { kind: "terminal", terminal: recovered.terminal, evidence: "execution became terminal during reconciliation" };
    }
    return { kind: "unknown", evidence: "transport cannot prove liveness, terminal state, or safe absence after restart" };
  }
  cancel(executionId: string, reason: string): DurableCancelResult<H> {
    nonempty("reason", reason);
    const live = this.live.get(executionId);
    if (!live) return { kind: "not_live", evidence: "this dispatcher has no owned live handle" };
    let current: DurableHarnessRecord<H> | undefined;
    try { current = this.options.ledger.get(executionId); }
    catch (error) {
      this.failLive(live, "ownership_lost", `cancellation ownership could not be verified: ${message(error)}`);
      return { kind: "ownership_lost", evidence: message(error) };
    }
    if (!current) return { kind: "ownership_lost", evidence: "execution record disappeared" };
    if (current.phase === "cancel_requested" && current.cancellation?.reason === reason) {
      if (!ownsLiveFence(current, live.fence, this.now())) {
        this.failLive(live, "ownership_lost", "cancellation owner lease changed or expired");
        return { kind: "ownership_lost", record: current, evidence: "cancellation owner lease changed or expired" };
      }
      live.controller.abort(new Error(reason));
      return { kind: "requested", record: current };
    }
    let result: ReturnType<DurableHarnessDispatcherOptions<H>["ledger"]["apply"]>;
    try { result = this.tryApply(current, { kind: "request_cancellation", fence: live.fence, reason }); }
    catch (error) {
      this.failLive(live, "recovery_required", `cancellation intent was not durable: ${message(error)}`);
      return { kind: "ownership_lost", record: current, evidence: message(error) };
    }
    if (!result.ok) {
      this.failLive(live, failureKind(result.kind), `cancellation intent was rejected: ${result.reason}`);
      return { kind: "ownership_lost", record: current, evidence: result.reason };
    }
    live.controller.abort(new Error(reason));
    return { kind: "requested", record: result.record };
  }
  private prepare<T>(input: DurableDispatchInput<H, T>): DurableHarnessRecord<H> {
    const conversation = input.request.target.kind === "resume" ? input.request.target.conversation : undefined;
    const result = this.options.ledger.apply({
      kind: "prepare",
      executionId: input.executionId,
      eventId: this.eventId(),
      expectedRevision: 0,
      occurredAt: this.iso(),
      execution: { executionId: input.executionId, ...(conversation ? { conversation } : {}) },
      ...(input.agent ? { agent: input.agent } : {}),
      harness: input.request.harness,
      requestKey: input.requestKey,
      target: input.request.target,
      owner: { supervisorId: this.options.supervisorId, generation: 1, leaseUntil: this.leaseUntil() },
    });
    if (!result.ok) throw new Error(`could not prepare execution: ${result.kind}: ${result.reason}`);
    if (!result.applied) throw new Error("dispatch requires a new execution identity");
    return result.record;
  }

  private preCancelled<T>(input: DurableDispatchInput<H, T>, record: DurableHarnessRecord<H>): DurableDispatchAck<T, H> {
    const reason = String(input.request.signal?.reason ?? "aborted before dispatch");
    const result = this.apply(input.executionId, {
      kind: "finish",
      fence: recordFence(record),
      terminal: { outcome: "cancelled", reason },
    });
    const terminal = result.terminal as ExecutionTerminal<DurableHarnessSuccess<T, H>>;
    const completion = Promise.resolve({ kind: "terminal", record: result, terminal } as DurableSettlement<T, H>);
    return { executionId: input.executionId, requestKey: input.requestKey, runnerRef: input.executionId, completion };
  }

  private startLive(executionId: string, fence: ExecutionOwnerFence, controller: AbortController, externalSignal?: AbortSignal): LiveExecution<H> {
    return startLiveExecution({
      fence,
      controller,
      schedule: this.schedule,
      renewEveryMs: this.renewEveryMs,
      onRenew: () => this.renew(executionId),
      onExternalAbort: () => { this.cancel(executionId, String(externalSignal?.reason ?? "aborted by caller")); },
      ...(externalSignal ? { externalSignal } : {}),
    });
  }

  private async runAdapter<T>(input: DurableDispatchInput<H, T>, live: LiveExecution<H>): Promise<DurableSettlement<T, H>> {
    try {
      const raced = await raceLiveResult(this.adapter.run({
        ...input.request,
        signal: live.controller.signal,
        onProgress: (progress) => this.progress(input.executionId, live, progress, input.request.onProgress),
      }), live);
      if (raced.kind === "problem") {
        return this.problemSettlement(input.executionId, live, raced.problem) as DurableSettlement<T, H>;
      }
      const result = raced.result;
      if (!result.ok && result.failure.kind === "runtime_error") {
        return this.problemSettlement(input.executionId, live, {
          kind: "recovery_required",
          evidence: `adapter runtime state is ambiguous: ${result.failure.reason}`,
        }) as DurableSettlement<T, H>;
      }
      return this.persistResult(input.executionId, live, result);
    } catch (error) {
      return this.problemSettlement(input.executionId, live, {
        kind: "recovery_required",
        evidence: `adapter threw after durable dispatch: ${message(error)}`,
      }) as DurableSettlement<T, H>;
    } finally {
      this.stopLive(input.executionId, live);
    }
  }

  private progress(executionId: string, live: LiveExecution<H>, progress: HarnessRunProgress, forward?: (progress: HarnessRunProgress) => void): void {
    if (progress.kind === "execution_started") {
      if (live.adapterExecutionId && live.adapterExecutionId !== progress.execution.executionId) {
        this.failLive(live, "recovery_required", "adapter execution identity changed during one dispatch");
      } else {
        live.adapterExecutionId = progress.execution.executionId;
        const read = readLedgerRecord(this.options.ledger, executionId);
        if (!read.ok || !read.record) this.failLive(live, "ownership_lost", read.ok ? "execution record disappeared" : read.evidence);
        const current = read.ok ? read.record : undefined;
        if (current && (current.phase === "dispatching" || current.phase === "recovery_required")) {
          try {
            const result = this.tryApply(current, {
              kind: "observe_running",
              fence: live.fence,
              runnerRef: executionId,
              adapterExecution: progress.execution,
              evidence: "adapter emitted execution_started",
            });
            if (!result.ok) this.failLive(live, failureKind(result.kind), result.reason);
          } catch (error) {
            this.failLive(live, "recovery_required", `could not persist running observation: ${message(error)}`);
          }
        }
      }
    }
    if (progress.kind === "conversation_identified") this.observeConversation(executionId, live, progress);
    forward?.(progress);
  }

  private observeConversation(executionId: string, live: LiveExecution<H>, progress: Extract<HarnessRunProgress, { kind: "conversation_identified" }>): void {
    if (live.adapterExecutionId && live.adapterExecutionId !== progress.executionId) {
      this.failLive(live, "recovery_required", "conversation referred to a different adapter execution");
      return;
    }
    try {
      const read = readLedgerRecord(this.options.ledger, executionId);
      if (!read.ok) {
        this.failLive(live, "ownership_lost", read.evidence);
        return;
      }
      const current = read.record;
      if (!current || isTerminalExecutionPhase(current.phase)) {
        this.failLive(live, "ownership_lost", "execution record is unavailable or terminal while identifying conversation");
        return;
      }
      const result = this.tryApply(current, { kind: "identify_conversation", fence: live.fence, conversation: progress.conversation });
      if (!result.ok) this.failLive(live, failureKind(result.kind), result.reason);
    } catch (error) {
      this.failLive(live, "recovery_required", `could not persist conversation identity: ${message(error)}`);
    }
  }

  private persistResult<T>(executionId: string, live: LiveExecution<H>, result: HarnessRunResult<T, H>): DurableSettlement<T, H> {
    const read = readLedgerRecord(this.options.ledger, executionId);
    if (!read.ok) return { kind: "ownership_lost", evidence: read.evidence };
    const current = read.record;
    if (!current) return { kind: "ownership_lost", evidence: "execution record disappeared before terminal persistence" };
    const terminal = terminalFromHarnessResult(result);
    const applied = this.tryApply(current, {
      kind: "finish",
      fence: live.fence,
      terminal: terminal as ExecutionTerminal<StoredSuccess<H>>,
      ...(result.execution ? { adapterExecution: result.execution } : {}),
      ...(result.conversation ? { conversation: result.conversation } : {}),
    });
    if (!applied.ok) return requireRecovery(current, live.fence, `terminal result was not durable: ${applied.reason}`, (record, fields) => this.tryApply(record, fields)) as DurableSettlement<T, H>;
    return {
      kind: "terminal",
      record: applied.record as ExecutionRecord<DurableHarnessSuccess<T, H>>,
      terminal,
    };
  }

  private renew(executionId: string): void {
    const live = this.live.get(executionId);
    if (!live) return;
    try {
      const current = this.options.ledger.get(executionId);
      if (!current || isTerminalExecutionPhase(current.phase)) {
        this.failLive(live, "ownership_lost", "execution record is unavailable or terminal during lease renewal");
        return;
      }
      const result = this.tryApply(current, { kind: "renew_owner", fence: live.fence, leaseUntil: this.leaseUntil() });
      if (!result.ok) this.failLive(live, failureKind(result.kind), `lease renewal failed: ${result.reason}`);
    } catch (error) {
      this.failLive(live, "ownership_lost", `lease renewal threw: ${message(error)}`);
    }
  }

  private failLive(live: LiveExecution<H>, kind: "ownership_lost" | "recovery_required", evidence: string): void {
    if (!live.problem) {
      live.problem = { kind, evidence };
      live.resolveProblem(live.problem);
    }
    live.controller.abort(new Error(evidence));
  }

  private problemSettlement(executionId: string, live: LiveExecution<H>, problem: NonNullable<LiveExecution<H>["problem"]>): DurableSettlement<unknown, H> {
    const read = readLedgerRecord(this.options.ledger, executionId);
    if (!read.ok) return { kind: "ownership_lost", evidence: `${problem.evidence}; ${read.evidence}` };
    if (problem.kind === "ownership_lost") return { kind: "ownership_lost", record: read.record, evidence: problem.evidence };
    return requireRecovery(read.record, live.fence, problem.evidence, (record, fields) => this.tryApply(record, fields));
  }

  private tryApply(
    current: DurableHarnessRecord<H>,
    fields: TransitionFields<H>,
  ): ReturnType<DurableHarnessDispatcherOptions<H>["ledger"]["apply"]> {
    return this.options.ledger.apply({
      ...fields,
      executionId: current.execution.executionId,
      eventId: this.eventId(),
      expectedRevision: current.revision,
      occurredAt: this.iso(),
    } as ExecutionTransition<StoredSuccess<H>>);
  }

  private apply(executionId: string, fields: TransitionFields<H>): DurableHarnessRecord<H> {
    const current = this.options.ledger.get(executionId);
    if (!current) throw new Error(`execution ${executionId} is missing`);
    const result = this.tryApply(current, fields);
    if (!result.ok) throw new Error(`${result.kind}: ${result.reason}`);
    return result.record;
  }

  private stopLive(executionId: string, live: LiveExecution<H>): void {
    this.unschedule(live.timer);
    live.externalSignal?.removeEventListener("abort", live.onExternalAbort!);
    if (this.live.get(executionId) === live) this.live.delete(executionId);
  }

  private iso(): string { return new Date(this.now()).toISOString(); }
  private leaseUntil(): string { return new Date(this.now() + this.options.leaseMs).toISOString(); }
}
