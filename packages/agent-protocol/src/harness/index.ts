import type { ConversationIdentity, ExecutionIdentity, UsageMeasurement } from "../index.js";

export const EXECUTION_CAPABILITIES = [
  "fresh_run",
  "resume",
  "fork",
  "structured_output",
  "interactive_approvals",
  "external_cancellation",
  "semantic_interrupt",
  "active_turn_steering",
  "idle_turn_submission",
  "persisted_transcript",
  "process_reattachment",
  "token_reporting",
] as const;

export type ExecutionCapability = (typeof EXECUTION_CAPABILITIES)[number];
export type CapabilityAssessment =
  | { status: "supported"; evidence: string }
  | { status: "unsupported" | "unverified"; reason: string };

export type LimitUnit = "milliseconds" | "usd" | "model_requests" | "agent_iterations" | "tokens";
export type OptionalLimitUnit = Exclude<LimitUnit, "milliseconds">;
export type LimitScope = "execution" | "conversation";
export type LimitEnforcement = "hard" | "advisory";

export interface ExecutionLimit {
  unit: OptionalLimitUnit;
  value: number;
  scope: LimitScope;
  enforcement: LimitEnforcement;
}

export interface LimitCapability {
  unit: LimitUnit;
  scope: LimitScope;
  enforcement: LimitEnforcement;
  assessment: CapabilityAssessment;
}

/** A factual report supplied by an adapter implementation, not a promise made by the core. */
export interface HarnessCapabilityDescriptor<H extends string = string> {
  harness: H;
  adapter: { name: string; version: string };
  capabilities: Record<ExecutionCapability, CapabilityAssessment>;
  limits: readonly LimitCapability[];
}

export type RunTarget =
  | { kind: "fresh"; namespace: string }
  | { kind: "resume"; conversation: ConversationIdentity };

export interface BoundedRunBase<H extends string = string> {
  prompt: string;
  cwd: string;
  target: RunTarget;
  /** Required hard deadline for this execution. Must be positive and finite. */
  wallTimeMs: number;
  limits?: readonly ExecutionLimit[];
  requires?: readonly ExecutionCapability[];
  signal?: AbortSignal;
  onProgress?: (progress: HarnessRunProgress<H>) => void;
}

export type HarnessRunProgress<H extends string = string> = { harness: H; atMs: number } & (
  | { kind: "execution_started"; execution: ExecutionIdentity }
  | { kind: "conversation_identified"; executionId: string; conversation: ConversationIdentity }
  | { kind: "assistant_output"; executionId: string; text: string }
  | { kind: "usage"; executionId: string; measurement: UsageMeasurement }
  | { kind: "execution_finished"; executionId: string; outcome: "succeeded" | "failed" | "cancelled" }
);

export type HarnessRunOutput<T> = { kind: "text"; text: string } | { kind: "structured"; value: T };

export interface TranscriptSourceHint {
  format: string;
  namespace: string;
  path?: string;
}

export type HarnessRunFailure =
  | { kind: "invalid_request"; reason: string }
  | { kind: "harness_mismatch"; reason: string }
  | {
      kind: "unsupported_requirement";
      reason: string;
      requirement: { kind: "capability"; capability: ExecutionCapability } | { kind: "limit"; limit: LimitCapability };
      status: "unsupported" | "unverified";
    }
  | { kind: "rate_limited"; reason: string; retryAtMs?: number; native?: unknown }
  | { kind: "limit_exceeded"; reason: string; unit: LimitUnit; native?: unknown }
  | { kind: "output_invalid"; reason: string; native?: unknown }
  | { kind: "auth_misconfigured"; reason: string; native?: unknown }
  | { kind: "aborted"; reason: string }
  | { kind: "wall_time_exceeded"; reason: string; wallTimeMs: number }
  | { kind: "cancelled_unknown"; reason: string; native?: unknown }
  | { kind: "runtime_error"; reason: string; native?: unknown };

export type HarnessRunResult<T = string, H extends string = string> =
  | {
      ok: true;
      harness: H;
      execution: ExecutionIdentity;
      conversation: ConversationIdentity;
      output: HarnessRunOutput<T>;
      usage: readonly UsageMeasurement[];
      transcript?: TranscriptSourceHint;
    }
  | {
      ok: false;
      harness: H;
      execution?: ExecutionIdentity;
      conversation?: ConversationIdentity;
      failure: HarnessRunFailure;
      usage: readonly UsageMeasurement[];
    };
