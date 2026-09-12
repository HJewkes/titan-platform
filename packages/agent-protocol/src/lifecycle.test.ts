import { describe, expect, expectTypeOf, it } from "vitest";
import {
  isTerminalExecutionPhase,
  reduceExecutionTransition,
  type ExecutionTransitionError,
  type ExecutionReconcileOutcome,
  type ExecutionRecord,
  type ExecutionTransition,
} from "./index.js";

const T0 = "2026-09-11T12:00:00.000Z";
const T1 = "2026-09-11T12:01:00.000Z";
const T2 = "2026-09-11T12:02:00.000Z";
const T3 = "2026-09-11T12:03:00.000Z";
const T4 = "2026-09-11T12:04:00.000Z";
const LEASE = "2026-09-11T13:00:00.000Z";
const fence = { supervisorId: "supervisor-a", generation: 1 };

function prepare(overrides: Partial<Extract<ExecutionTransition<string>, { kind: "prepare" }>> = {}) {
  return {
    kind: "prepare",
    executionId: "execution-1",
    eventId: "execution-1:prepare",
    expectedRevision: 0,
    occurredAt: T0,
    execution: { executionId: "execution-1" },
    agent: { agentId: "agent-1" },
    harness: "codex",
    requestKey: "workflow/run/step/0/0",
    target: { kind: "fresh", namespace: "local" },
    owner: { ...fence, leaseUntil: LEASE },
    ...overrides,
  } as Extract<ExecutionTransition<string>, { kind: "prepare" }>;
}

function apply(
  current: ExecutionRecord<string> | undefined,
  transition: ExecutionTransition<string>,
): ExecutionRecord<string> {
  return reduceExecutionTransition(current, transition);
}

function event<K extends Exclude<ExecutionTransition<string>["kind"], "prepare">>(
  kind: K,
  expectedRevision: number,
  occurredAt: string,
  fields: Omit<Extract<ExecutionTransition<string>, { kind: K }>, "kind" | "executionId" | "eventId" | "expectedRevision" | "occurredAt">,
): Extract<ExecutionTransition<string>, { kind: K }> {
  return { kind, executionId: "execution-1", eventId: `execution-1:${kind}:${expectedRevision}`, expectedRevision, occurredAt, ...fields } as Extract<
    ExecutionTransition<string>,
    { kind: K }
  >;
}

function running(): ExecutionRecord<string> {
  let record = apply(undefined, prepare());
  record = apply(record, event("begin_dispatch", 1, T1, { fence }));
  return apply(record, event("observe_running", 2, T2, {
    fence,
    runnerRef: "ledger:execution-1",
    adapterExecution: { executionId: "adapter-run-1" },
    evidence: "native launch acknowledged",
  }));
}

function expectCode(fn: () => unknown, code: ExecutionTransitionError["code"]): void {
  expect(fn).toThrow(expect.objectContaining({ name: "ExecutionTransitionError", code }));
}

describe("execution lifecycle transitions", () => {
  it("records prepare, dispatch acknowledgment, cancellation intent and natural success", () => {
    let record = running();
    expect(record).toMatchObject({ phase: "running", revision: 3, runnerRef: "ledger:execution-1" });

    record = apply(record, event("request_cancellation", 3, T3, { fence, reason: "operator stop" }));
    record = apply(record, event("finish", 4, T4, { fence, terminal: { outcome: "succeeded", result: "already completed" } }));

    expect(record).toMatchObject({
      phase: "succeeded",
      revision: 5,
      cancellation: { reason: "operator stop" },
      terminal: { outcome: "succeeded", result: "already completed" },
      owner: undefined,
    });
    expect(isTerminalExecutionPhase(record.phase)).toBe(true);
  });

  it("keeps recovery evidence and returns to running only from positive observation", () => {
    let record = apply(undefined, prepare());
    record = apply(record, event("begin_dispatch", 1, T1, { fence }));
    record = apply(record, event("require_recovery", 2, T2, { fence, evidence: "supervisor restarted after launch" }));
    expect(record).toMatchObject({ phase: "recovery_required", recovery: { requiredAt: T2 } });

    record = apply(record, event("observe_running", 3, T3, {
      fence,
      runnerRef: "ledger:execution-1",
      adapterExecution: { executionId: "adapter-run-1" },
      evidence: "transport found exact invocation",
    }));
    expect(record).toMatchObject({ phase: "running", recovery: undefined });
  });

  it("treats cancellation unknown as an absorbing terminal outcome", () => {
    let record = running();
    record = apply(record, event("request_cancellation", 3, T3, { fence, reason: "deadline" }));
    record = apply(record, event("finish", 4, T4, {
      fence,
      terminal: { outcome: "cancellation_unknown", reason: "process group signalled", evidence: "no native terminal event" },
    }));
    expect(record.phase).toBe("cancellation_unknown");
    expectCode(() => apply(record, event("claim_owner", 5, LEASE, { owner: { supervisorId: "supervisor-b", generation: 2, leaseUntil: "2026-09-11T14:00:00.000Z" } })), "invalid_transition");
  });

  it("rejects skipped, stale-revision and backdated transitions", () => {
    const record = apply(undefined, prepare());
    expectCode(
      () => apply(record, event("observe_running", 1, T1, {
        fence,
        runnerRef: "r",
        adapterExecution: { executionId: "adapter-run-1" },
        evidence: "not enough",
      })),
      "invalid_transition",
    );
    expectCode(() => apply(record, event("begin_dispatch", 0, T1, { fence })), "revision_conflict");
    expectCode(() => apply(record, event("begin_dispatch", 1, "2026-09-11T11:59:00.000Z", { fence })), "invalid_transition");
  });

  it("allows only failed or cancelled terminal outcomes before dispatch", () => {
    const record = apply(undefined, prepare());
    expectCode(() => apply(record, event("finish", 1, T1, { fence, terminal: { outcome: "succeeded", result: "impossible" } })), "invalid_transition");
    const failed = apply(record, event("finish", 1, T1, { fence, terminal: { outcome: "failed", reason: "preflight", retryable: false } }));
    expect(failed.phase).toBe("failed");
  });
});

describe("identity and ownership fencing", () => {
  it("requires resume execution and target identities to agree", () => {
    const conversation = { harness: "claude-code", namespace: "local", nativeId: "session-1" };
    const valid = prepare({
      harness: "claude-code",
      execution: { executionId: "execution-1", conversation },
      target: { kind: "resume", conversation },
    });
    expect(apply(undefined, valid).execution.conversation).toEqual(conversation);

    expectCode(
      () => apply(undefined, prepare({ harness: "claude-code", target: { kind: "resume", conversation } })),
      "invalid_transition",
    );
  });

  it("rejects a mismatched prepared execution identity", () => {
    expectCode(() => apply(undefined, prepare({ executionId: "other-execution" })), "invalid_transition");
  });

  it("sets a fresh conversation once and rejects replacement", () => {
    let record = apply(undefined, prepare());
    record = apply(record, event("begin_dispatch", 1, T1, { fence }));
    const first = { harness: "codex", namespace: "local", nativeId: "thread-1" };
    record = apply(record, event("identify_conversation", 2, T2, { fence, conversation: first }));
    expect(record.execution.conversation).toEqual(first);
    const other = { ...first, nativeId: "thread-2" };
    expectCode(() => apply(record, event("identify_conversation", 3, T3, { fence, conversation: other })), "invalid_transition");
  });

  it("rejects a conversation outside the fresh target namespace", () => {
    let record = apply(undefined, prepare());
    record = apply(record, event("begin_dispatch", 1, T1, { fence }));
    const conversation = { harness: "codex", namespace: "other-host", nativeId: "thread-1" };
    expectCode(() => apply(record, event("identify_conversation", 2, T2, { fence, conversation })), "invalid_transition");
  });

  it("keeps the adapter invocation separate and immutable", () => {
    const record = running();
    expect(record).toMatchObject({
      execution: { executionId: "execution-1" },
      adapterExecution: { executionId: "adapter-run-1" },
    });
    expectCode(
      () => apply(record, event("finish", 3, T3, {
        fence,
        adapterExecution: { executionId: "adapter-run-2" },
        terminal: { outcome: "failed", reason: "ended", retryable: false },
      })),
      "invalid_transition",
    );
  });

  it("promotes a conversation observed on the adapter execution", () => {
    let record = apply(undefined, prepare());
    record = apply(record, event("begin_dispatch", 1, T1, { fence }));
    const conversation = { harness: "codex", namespace: "local", nativeId: "thread-1" };
    record = apply(record, event("observe_running", 2, T2, {
      fence,
      runnerRef: "ledger:execution-1",
      adapterExecution: { executionId: "adapter-run-1", conversation },
      evidence: "native launch acknowledged",
    }));
    expect(record.execution.conversation).toEqual(conversation);
    expect(record.adapterExecution?.conversation).toEqual(conversation);
  });

  it("rejects stale owners and fences takeover with increasing generations", () => {
    let record = running();
    const stale = { supervisorId: "supervisor-b", generation: 2, leaseUntil: "2026-09-11T12:30:00.000Z" };
    expectCode(() => apply(record, event("claim_owner", 3, T3, { owner: stale })), "ownership_lost");
    expectCode(() => apply(record, event("finish", 3, T3, { fence: { supervisorId: "supervisor-b", generation: 1 }, terminal: { outcome: "cancelled", reason: "stale" } })), "ownership_lost");

    record = apply(record, event("claim_owner", 3, LEASE, { owner: { supervisorId: "supervisor-b", generation: 2, leaseUntil: "2026-09-11T14:00:00.000Z" } }));
    expect(record).toMatchObject({ ownerGeneration: 2, owner: { supervisorId: "supervisor-b", generation: 2 } });
    expectCode(() => apply(record, event("renew_owner", 4, "2026-09-11T13:01:00.000Z", { fence, leaseUntil: "2026-09-11T15:00:00.000Z" })), "ownership_lost");
  });

  it("requires renewal to extend a live matching lease", () => {
    const record = running();
    expectCode(() => apply(record, event("renew_owner", 3, T3, { fence, leaseUntil: LEASE })), "invalid_transition");
    const renewed = apply(record, event("renew_owner", 3, T3, { fence, leaseUntil: "2026-09-11T14:00:00.000Z" }));
    expect(renewed.owner?.leaseUntil).toBe("2026-09-11T14:00:00.000Z");
  });

  it.each([
    prepare({ executionId: " " }),
    prepare({ eventId: "" }),
    prepare({ requestKey: "" }),
    prepare({ owner: { ...fence, generation: 0, leaseUntil: LEASE } }),
    prepare({ occurredAt: "not-a-time" }),
  ])("rejects malformed durable input %#", (transition) => {
    expectCode(() => apply(undefined, transition), "invalid_transition");
  });

  it("categorizes malformed untyped terminal and transition kinds", () => {
    const record = running();
    const malformedTerminal = event("finish", 3, T3, { fence, terminal: { outcome: "cancelled", reason: "x" } });
    (malformedTerminal.terminal as { outcome: string }).outcome = "vanished";
    expectCode(() => apply(record, malformedTerminal), "invalid_transition");

    const malformedKind = event("begin_dispatch", 3, T3, { fence }) as unknown as { kind: string };
    malformedKind.kind = "teleport";
    expectCode(() => apply(record, malformedKind as ExecutionTransition<string>), "invalid_transition");
  });

  it("rejects an untyped success terminal without a result", () => {
    const record = running();
    const transition = event("finish", 3, T3, {
      fence,
      terminal: { outcome: "succeeded", result: "placeholder" },
    });
    delete (transition.terminal as { result?: string }).result;
    expectCode(() => apply(record, transition), "invalid_transition");
  });

  it("categorizes a transition for an absent execution", () => {
    expectCode(() => apply(undefined, event("begin_dispatch", 1, T1, { fence })), "not_found");
  });
});

it("keeps reconciliation results independent of transport handles", () => {
  type Outcome = ExecutionReconcileOutcome<string, { completion: Promise<string> }>;
  const unknown: Outcome = { kind: "unknown", evidence: "transport cannot attach" };
  const terminal: Outcome = { kind: "terminal", terminal: { outcome: "succeeded", result: "done" }, evidence: "ledger" };
  expectTypeOf(unknown).toMatchTypeOf<Outcome>();
  expect(terminal.kind).toBe("terminal");
});
