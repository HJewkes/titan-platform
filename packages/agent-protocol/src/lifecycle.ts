import type { AgentIdentity, ConversationIdentity, ExecutionIdentity, SurfaceIdentity } from "./index.js";

export const EXECUTION_PHASES = [
  "prepared",
  "dispatching",
  "running",
  "cancel_requested",
  "recovery_required",
  "succeeded",
  "failed",
  "cancelled",
  "cancellation_unknown",
] as const;

export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];
export type TerminalExecutionPhase = "succeeded" | "failed" | "cancelled" | "cancellation_unknown";

export interface ExecutionOwnerFence {
  supervisorId: string;
  generation: number;
}

export interface ExecutionOwnerLease extends ExecutionOwnerFence {
  leaseUntil: string;
}

export type LifecycleExecutionTarget =
  | { kind: "fresh"; namespace: string }
  | { kind: "resume"; conversation: ConversationIdentity };

export type ExecutionTerminal<TResult = unknown> =
  | { outcome: "succeeded"; result: TResult }
  | { outcome: "failed"; reason: string; retryable: boolean }
  | { outcome: "cancelled"; reason: string }
  | { outcome: "cancellation_unknown"; reason: string; evidence: string };

export interface ExecutionRecord<TResult = unknown> {
  execution: ExecutionIdentity;
  agent?: AgentIdentity;
  harness: string;
  requestKey: string;
  target: LifecycleExecutionTarget;
  phase: ExecutionPhase;
  revision: number;
  ownerGeneration: number;
  owner?: ExecutionOwnerLease;
  runnerRef?: string;
  /** Adapter-assigned invocation identity, distinct from the caller's durable execution ID. */
  adapterExecution?: ExecutionIdentity;
  surface?: SurfaceIdentity;
  preparedAt: string;
  dispatchedAt?: string;
  cancellation?: { requestedAt: string; reason: string };
  recovery?: { requiredAt: string; evidence: string };
  finishedAt?: string;
  lastObservedAt: string;
  terminal?: ExecutionTerminal<TResult>;
}

interface ExecutionTransitionBase {
  executionId: string;
  eventId: string;
  expectedRevision: number;
  occurredAt: string;
}

export type ExecutionTransition<TResult = unknown> =
  | (ExecutionTransitionBase & {
      kind: "prepare";
      expectedRevision: 0;
      execution: ExecutionIdentity;
      agent?: AgentIdentity;
      harness: string;
      requestKey: string;
      target: LifecycleExecutionTarget;
      owner: ExecutionOwnerLease;
    })
  | (ExecutionTransitionBase & { kind: "begin_dispatch"; fence: ExecutionOwnerFence })
  | (ExecutionTransitionBase & {
      kind: "observe_running";
      fence: ExecutionOwnerFence;
      runnerRef: string;
      adapterExecution: ExecutionIdentity;
      conversation?: ConversationIdentity;
      surface?: SurfaceIdentity;
      evidence: string;
    })
  | (ExecutionTransitionBase & {
      kind: "identify_conversation";
      fence: ExecutionOwnerFence;
      conversation: ConversationIdentity;
    })
  | (ExecutionTransitionBase & {
      kind: "request_cancellation";
      fence: ExecutionOwnerFence;
      reason: string;
    })
  | (ExecutionTransitionBase & {
      kind: "require_recovery";
      fence: ExecutionOwnerFence;
      evidence: string;
    })
  | (ExecutionTransitionBase & {
      kind: "finish";
      fence: ExecutionOwnerFence;
      terminal: ExecutionTerminal<TResult>;
      adapterExecution?: ExecutionIdentity;
      conversation?: ConversationIdentity;
    })
  | (ExecutionTransitionBase & { kind: "claim_owner"; owner: ExecutionOwnerLease })
  | (ExecutionTransitionBase & { kind: "renew_owner"; fence: ExecutionOwnerFence; leaseUntil: string })
  | (ExecutionTransitionBase & { kind: "release_owner"; fence: ExecutionOwnerFence });

export type ExecutionReconcileOutcome<TResult, TRunning> =
  | { kind: "running"; running: TRunning; evidence: string }
  | { kind: "terminal"; terminal: ExecutionTerminal<TResult>; evidence: string }
  | { kind: "not_found"; retrySafe: boolean; evidence: string }
  | { kind: "ownership_lost"; evidence: string }
  | { kind: "unknown"; evidence: string };
