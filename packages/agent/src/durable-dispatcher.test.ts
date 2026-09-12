import type { ApplyExecutionTransitionResult, ExecutionLedger } from "@titan-design/agent-lifecycle";
import {
  ExecutionTransitionError,
  reduceExecutionTransition,
  type ExecutionRecord,
  type ExecutionTransition,
} from "@titan-design/agent-protocol";
import { describe, expect, it, vi } from "vitest";
import { codexExecCapabilities } from "./codex-exec.js";
import { createDurableHarnessDispatcher } from "./durable-dispatcher.js";
import type { DurableHarnessSuccess } from "./durable-types.js";
import type { CodexRunRequest, HarnessAdapter, HarnessRunResult } from "./harness-contracts.js";

type Stored = DurableHarnessSuccess<unknown, "codex">;

class MemoryLedger implements ExecutionLedger<Stored> {
  readonly records = new Map<string, ExecutionRecord<Stored>>();
  readonly receipts = new Map<string, ExecutionTransition<Stored>[]>();
  rejectKind: ExecutionTransition<Stored>["kind"] | undefined;
  throwReads = false;

  get(executionId: string) {
    if (this.throwReads) throw new Error("ledger read unavailable");
    return this.records.get(executionId);
  }
  findByRequestKey(requestKey: string) { return [...this.records.values()].find((record) => record.requestKey === requestKey); }
  listRecoverable() { return [...this.records.values()].filter((record) => !record.terminal); }
  events(executionId: string) { return this.receipts.get(executionId) ?? []; }

  apply(transition: ExecutionTransition<Stored>): ApplyExecutionTransitionResult<Stored> {
    const current = this.get(transition.executionId);
    if (this.rejectKind === transition.kind) return { ok: false, kind: "ownership_lost", reason: `rejected ${transition.kind}`, current };
    try {
      const record = reduceExecutionTransition(current, transition);
      this.records.set(transition.executionId, record);
      this.receipts.set(transition.executionId, [...this.events(transition.executionId), transition]);
      return { ok: true, applied: true, record };
    } catch (error) {
      if (error instanceof ExecutionTransitionError) return { ok: false, kind: error.code, reason: error.message, current };
      throw error;
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function request(overrides: Partial<CodexRunRequest<unknown>> = {}): CodexRunRequest<unknown> {
  return {
    harness: "codex",
    prompt: "inspect",
    cwd: "/tmp/project",
    target: { kind: "fresh", namespace: "local" },
    wallTimeMs: 1_000,
    native: { model: "gpt-6" },
    ...overrides,
  };
}

function success<T>(value: T): HarnessRunResult<T, "codex"> {
  const conversation = { harness: "codex", namespace: "local", nativeId: "thread-1" };
  return {
    ok: true,
    harness: "codex",
    execution: { executionId: "adapter-execution", conversation },
    conversation,
    output: { kind: "structured", value },
    usage: [],
  };
}

function setup(
  adapter: HarnessAdapter<"codex">,
  ledger = new MemoryLedger(),
  initialNow = Date.parse("2026-09-11T12:00:00.000Z"),
  supervisorId = "supervisor-a",
) {
  let now = initialNow;
  let sequence = 0;
  let renewal: (() => void) | undefined;
  const clear = vi.fn();
  const dispatcher = createDurableHarnessDispatcher(
    adapter,
    { ledger, supervisorId, leaseMs: 3_000, renewEveryMs: 1_000 },
    {
      now: () => now,
      eventId: () => `event-${++sequence}`,
      setInterval: ((callback: () => void) => { renewal = callback; return { unref: vi.fn() }; }) as unknown as typeof setInterval,
      clearInterval: clear as unknown as typeof clearInterval,
    },
  );
  return { dispatcher, ledger, setNow: (value: number) => { now = value; }, renew: () => renewal?.(), clear };
}

function controlledAdapter(
  run: (request: CodexRunRequest<unknown>) => Promise<HarnessRunResult<unknown, "codex">>,
): HarnessAdapter<"codex"> {
  return { descriptor: codexExecCapabilities(), run: run as HarnessAdapter<"codex">["run"] };
}

describe("durable harness dispatch", () => {
  it("persists dispatch before invocation, acknowledges early, and stores terminal before resolving", async () => {
    const result = deferred<HarnessRunResult<unknown, "codex">>();
    const ledger = new MemoryLedger();
    let invokedPhase: string | undefined;
    const adapter = controlledAdapter(async (runRequest) => {
      invokedPhase = ledger.get("durable-execution")?.phase;
      runRequest.onProgress?.({ harness: "codex", atMs: 1, kind: "execution_started", execution: { executionId: "adapter-execution" } });
      runRequest.onProgress?.({
        harness: "codex",
        atMs: 2,
        kind: "conversation_identified",
        executionId: "adapter-execution",
        conversation: { harness: "codex", namespace: "local", nativeId: "thread-1" },
      });
      return result.promise;
    });
    const { dispatcher } = setup(adapter, ledger);

    const ack = await dispatcher.dispatch({ executionId: "durable-execution", requestKey: "request-1", request: request() });
    expect(invokedPhase).toBe("dispatching");
    expect(ack).toMatchObject({ executionId: "durable-execution", runnerRef: "durable-execution" });
    expect(ledger.get("durable-execution")).toMatchObject({
      phase: "running",
      execution: { executionId: "durable-execution" },
      adapterExecution: { executionId: "adapter-execution" },
    });

    result.resolve(success({ answer: 42 }));
    const settled = await ack.completion;
    expect(settled.kind).toBe("terminal");
    expect(ledger.get("durable-execution")).toMatchObject({ phase: "succeeded", terminal: { outcome: "succeeded" } });
    if (settled.kind === "terminal" && settled.terminal.outcome === "succeeded") {
      expect(settled.terminal.result.adapterExecution.executionId).toBe("adapter-execution");
    }
  });

  it("does not invoke the adapter for a pre-aborted request", async () => {
    const run = vi.fn(async () => success("unused"));
    const { dispatcher, ledger } = setup(controlledAdapter(run));
    const ack = await dispatcher.dispatch({
      executionId: "pre-aborted",
      requestKey: "request-aborted",
      request: request({ signal: AbortSignal.abort("stop before launch") }),
    });
    expect(run).not.toHaveBeenCalled();
    expect(await ack.completion).toMatchObject({ kind: "terminal", terminal: { outcome: "cancelled", reason: "stop before launch" } });
    expect(ledger.events("pre-aborted").map((event) => event.kind)).toEqual(["prepare", "finish"]);
  });

  it("persists cancellation intent before abort and reports unknown without native terminal evidence", async () => {
    const adapter = controlledAdapter(async (runRequest) => {
      runRequest.onProgress?.({ harness: "codex", atMs: 1, kind: "execution_started", execution: { executionId: "adapter-execution" } });
      await new Promise<void>((resolve) => runRequest.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { ok: false, harness: "codex", execution: { executionId: "adapter-execution" }, failure: { kind: "aborted", reason: "signalled" }, usage: [] };
    });
    const { dispatcher, ledger } = setup(adapter);
    const ack = await dispatcher.dispatch({ executionId: "cancelled", requestKey: "request-cancel", request: request() });
    expect(dispatcher.cancel("cancelled", "operator stop")).toMatchObject({ kind: "requested", record: { phase: "cancel_requested" } });
    const settled = await ack.completion;
    expect(settled).toMatchObject({ kind: "terminal", terminal: { outcome: "cancellation_unknown" } });
    expect(ledger.events("cancelled").map((event) => event.kind)).toContain("request_cancellation");
  });

  it("renews its lease while work is live and fails closed when renewal loses ownership", async () => {
    const result = deferred<HarnessRunResult<unknown, "codex">>();
    const adapter = controlledAdapter(async () => result.promise);
    const { dispatcher, ledger, setNow, renew } = setup(adapter);
    const ack = await dispatcher.dispatch({ executionId: "renewed", requestKey: "request-renew", request: request() });
    const firstLease = ledger.get("renewed")?.owner?.leaseUntil;
    setNow(Date.parse("2026-09-11T12:00:01.000Z"));
    renew();
    expect(ledger.get("renewed")?.owner?.leaseUntil).not.toBe(firstLease);

    ledger.rejectKind = "renew_owner";
    setNow(Date.parse("2026-09-11T12:00:02.000Z"));
    renew();
    expect(await ack.completion).toMatchObject({ kind: "ownership_lost", evidence: expect.stringContaining("lease renewal failed") });
  });

  it("turns an undurable structured success into recovery required", async () => {
    const ledger = new MemoryLedger();
    ledger.apply = ((original) => (transition: ExecutionTransition<Stored>) => {
      if (transition.kind === "finish" && transition.terminal.outcome === "succeeded") {
        return { ok: false, kind: "invalid_transition", reason: "not JSON safe", current: ledger.get(transition.executionId) };
      }
      return original.call(ledger, transition);
    })(ledger.apply);
    const adapter = controlledAdapter(async () => success(new Date("2026-09-11T12:00:00Z")));
    const { dispatcher } = setup(adapter, ledger);
    const ack = await dispatcher.dispatch({ executionId: "non-json", requestKey: "request-json", request: request() });
    expect(await ack.completion).toMatchObject({ kind: "recovery_required", evidence: expect.stringContaining("not durable") });
    expect(ledger.get("non-json")?.phase).toBe("recovery_required");
  });

  it("does not let a stale live completion adopt a takeover fence", async () => {
    const result = deferred<HarnessRunResult<unknown, "codex">>();
    const ledger = new MemoryLedger();
    const first = setup(controlledAdapter(async () => result.promise), ledger);
    const ack = await first.dispatcher.dispatch({ executionId: "taken-over", requestKey: "request-takeover", request: request() });

    const second = setup(
      controlledAdapter(async () => success("must not launch")),
      ledger,
      Date.parse("2026-09-11T12:01:00.000Z"),
      "supervisor-b",
    );
    await expect(second.dispatcher.reconcile("taken-over")).resolves.toMatchObject({ kind: "unknown" });
    expect(ledger.get("taken-over")).toMatchObject({
      phase: "recovery_required",
      owner: { supervisorId: "supervisor-b", generation: 2 },
    });

    result.resolve(success("late success"));
    await expect(ack.completion).resolves.toMatchObject({ kind: "ownership_lost" });
    expect(ledger.get("taken-over")?.phase).toBe("recovery_required");
    expect(ledger.get("taken-over")?.terminal).toBeUndefined();
  });

  it("does not let a stale owner reuse an idempotent cancellation shortcut", async () => {
    const result = deferred<HarnessRunResult<unknown, "codex">>();
    const ledger = new MemoryLedger();
    const first = setup(controlledAdapter(async () => result.promise), ledger);
    await first.dispatcher.dispatch({ executionId: "stale-cancel", requestKey: "request-stale-cancel", request: request() });
    expect(first.dispatcher.cancel("stale-cancel", "operator stop")).toMatchObject({ kind: "requested" });

    const current = ledger.get("stale-cancel");
    if (!current) throw new Error("missing execution");
    const claimed = ledger.apply({
      kind: "claim_owner",
      executionId: "stale-cancel",
      eventId: "takeover",
      expectedRevision: current.revision,
      occurredAt: "2026-09-11T12:01:00.000Z",
      owner: { supervisorId: "supervisor-b", generation: 2, leaseUntil: "2026-09-11T13:00:00.000Z" },
    });
    if (!claimed.ok) throw new Error(claimed.reason);
    first.setNow(Date.parse("2026-09-11T12:01:00.000Z"));
    expect(first.dispatcher.cancel("stale-cancel", "operator stop")).toMatchObject({ kind: "ownership_lost" });
    expect(ledger.get("stale-cancel")?.owner?.supervisorId).toBe("supervisor-b");
    result.resolve(success("late"));
  });

  it("does not advertise a same-instance handle after its lease expires", async () => {
    const result = deferred<HarnessRunResult<unknown, "codex">>();
    const running = setup(controlledAdapter(async () => result.promise));
    const ack = await running.dispatcher.dispatch({ executionId: "expired-live", requestKey: "request-expired", request: request() });
    running.setNow(Date.parse("2026-09-11T12:00:04.000Z"));
    await expect(running.dispatcher.reconcile("expired-live")).resolves.toMatchObject({ kind: "ownership_lost" });
    result.resolve(success("late"));
    await expect(ack.completion).resolves.toMatchObject({ kind: "ownership_lost" });
  });

  it("keeps ambiguous adapter runtime loss nonterminal", async () => {
    const adapter = controlledAdapter(async () => ({
      ok: false,
      harness: "codex",
      execution: { executionId: "adapter-execution" },
      failure: { kind: "runtime_error", reason: "stream ended before native terminal" },
      usage: [],
    }));
    const { dispatcher, ledger } = setup(adapter);
    const ack = await dispatcher.dispatch({ executionId: "runtime-loss", requestKey: "request-loss", request: request() });
    await expect(ack.completion).resolves.toMatchObject({ kind: "recovery_required" });
    expect(ledger.get("runtime-loss")?.phase).toBe("recovery_required");
  });

  it("settles ownership lost when a failure-path ledger read throws", async () => {
    const ledger = new MemoryLedger();
    const adapter = controlledAdapter(async () => {
      ledger.throwReads = true;
      return {
        ok: false,
        harness: "codex",
        failure: { kind: "runtime_error", reason: "transport vanished" },
        usage: [],
      };
    });
    const { dispatcher } = setup(adapter, ledger);
    const ack = await dispatcher.dispatch({ executionId: "read-failure", requestKey: "request-read-failure", request: request() });
    await expect(ack.completion).resolves.toMatchObject({ kind: "ownership_lost", evidence: expect.stringContaining("ledger read failed") });
  });
});

describe("durable reconciliation", () => {
  it("never treats a missing execution as retry-safe", async () => {
    const run = vi.fn(async () => success("unused"));
    const { dispatcher } = setup(controlledAdapter(run));
    await expect(dispatcher.reconcile("missing")).resolves.toEqual({
      kind: "unknown",
      evidence: expect.stringContaining("cannot be excluded"),
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("closes an expired prepared record as a retryable terminal failure without dispatch", async () => {
    const run = vi.fn(async () => success("unused"));
    const ledger = new MemoryLedger();
    ledger.apply({
      kind: "prepare",
      executionId: "prepared",
      eventId: "prepare",
      expectedRevision: 0,
      occurredAt: "2026-09-11T12:00:00.000Z",
      execution: { executionId: "prepared" },
      harness: "codex",
      requestKey: "prepared-request",
      target: { kind: "fresh", namespace: "local" },
      owner: { supervisorId: "old", generation: 1, leaseUntil: "2026-09-11T12:00:01.000Z" },
    });
    const { dispatcher } = setup(controlledAdapter(run), ledger, Date.parse("2026-09-11T12:01:00.000Z"));
    await expect(dispatcher.reconcile("prepared")).resolves.toMatchObject({
      kind: "terminal",
      terminal: { outcome: "failed", retryable: true },
    });
    expect(run).not.toHaveBeenCalled();
    expect(ledger.get("prepared")?.phase).toBe("failed");
  });

  it("marks post-dispatch restart uncertainty for recovery without relaunch", async () => {
    const run = vi.fn(async () => success("unused"));
    const ledger = new MemoryLedger();
    const prepared = ledger.apply({
      kind: "prepare",
      executionId: "uncertain",
      eventId: "prepare",
      expectedRevision: 0,
      occurredAt: "2026-09-11T12:00:00.000Z",
      execution: { executionId: "uncertain" },
      harness: "codex",
      requestKey: "uncertain-request",
      target: { kind: "fresh", namespace: "local" },
      owner: { supervisorId: "old", generation: 1, leaseUntil: "2026-09-11T12:00:01.000Z" },
    });
    if (!prepared.ok) throw new Error(prepared.reason);
    ledger.apply({ kind: "begin_dispatch", executionId: "uncertain", eventId: "begin", expectedRevision: prepared.record.revision,
      occurredAt: "2026-09-11T12:00:00.000Z", fence: { supervisorId: "old", generation: 1 } });
    const { dispatcher } = setup(controlledAdapter(run), ledger, Date.parse("2026-09-11T12:01:00.000Z"));
    await expect(dispatcher.reconcile("uncertain")).resolves.toMatchObject({ kind: "unknown" });
    expect(ledger.get("uncertain")?.phase).toBe("recovery_required");
    expect(run).not.toHaveBeenCalled();
  });
});
