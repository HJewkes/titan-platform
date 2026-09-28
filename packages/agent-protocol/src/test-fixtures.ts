import { expect } from "vitest";
import {
  reduceExecutionTransition,
  type ExecutionRecord,
  type ExecutionTransition,
  type ExecutionTransitionError,
} from "./index.js";

export const T0 = "2026-09-11T12:00:00.000Z";
export const T1 = "2026-09-11T12:01:00.000Z";
export const T2 = "2026-09-11T12:02:00.000Z";
export const T3 = "2026-09-11T12:03:00.000Z";
export const T4 = "2026-09-11T12:04:00.000Z";
export const LEASE = "2026-09-11T13:00:00.000Z";
export const fence = { supervisorId: "supervisor-a", generation: 1 };

export type PrepareTransition = Extract<ExecutionTransition<string>, { kind: "prepare" }>;

export function prepare(overrides: Partial<PrepareTransition> = {}): PrepareTransition {
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
  } as PrepareTransition;
}

export function apply(current: ExecutionRecord<string> | undefined, transition: ExecutionTransition<string>): ExecutionRecord<string> {
  return reduceExecutionTransition(current, transition);
}

type EventKind = Exclude<ExecutionTransition<string>["kind"], "prepare">;
type EventFields<K extends EventKind> = Omit<
  Extract<ExecutionTransition<string>, { kind: K }>,
  "kind" | "executionId" | "eventId" | "expectedRevision" | "occurredAt"
>;

export function event<K extends EventKind>(
  kind: K,
  expectedRevision: number,
  occurredAt: string,
  fields: EventFields<K>,
): Extract<ExecutionTransition<string>, { kind: K }> {
  const envelope = { kind, executionId: "execution-1", eventId: `execution-1:${kind}:${expectedRevision}`, expectedRevision, occurredAt };
  return { ...envelope, ...fields } as Extract<ExecutionTransition<string>, { kind: K }>;
}

export function dispatching(): ExecutionRecord<string> {
  return apply(apply(undefined, prepare()), event("begin_dispatch", 1, T1, { fence }));
}

export function running(): ExecutionRecord<string> {
  return apply(dispatching(), event("observe_running", 2, T2, {
    fence,
    runnerRef: "ledger:execution-1",
    adapterExecution: { executionId: "adapter-run-1" },
    evidence: "native launch acknowledged",
  }));
}

export function expectCode(fn: () => unknown, code: ExecutionTransitionError["code"]): void {
  expect(fn).toThrow(expect.objectContaining({ name: "ExecutionTransitionError", code }));
}
