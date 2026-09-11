import type {
  AgentDefinition,
  HookCallbackMatcher,
  HookEvent,
  McpServerConfig,
  PermissionMode,
  SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type { ConversationIdentity, ExecutionIdentity, UsageMeasurement } from "@titan-design/agent-protocol";
import type { ZodType } from "zod";

export type Harness = "claude-code" | "codex";

export const CODEX_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"] as const;
export const CODEX_APPROVAL_POLICIES = ["untrusted", "on-failure", "on-request", "never"] as const;
export type CodexSandbox = (typeof CODEX_SANDBOXES)[number];
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];

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
export interface HarnessCapabilityDescriptor<H extends Harness = Harness> {
  harness: H;
  adapter: { name: string; version: string };
  capabilities: Record<ExecutionCapability, CapabilityAssessment>;
  limits: readonly LimitCapability[];
}

export type RunTarget =
  | { kind: "fresh"; namespace: string }
  | { kind: "resume"; conversation: ConversationIdentity };

export interface BoundedRunBase {
  prompt: string;
  cwd: string;
  target: RunTarget;
  /** Required hard deadline for this execution. Must be positive and finite. */
  wallTimeMs: number;
  limits?: readonly ExecutionLimit[];
  requires?: readonly ExecutionCapability[];
  signal?: AbortSignal;
  onProgress?: (progress: HarnessRunProgress) => void;
}

/** Anthropic SDK configuration remains confined to the Claude Code branch. */
export interface ClaudeCodeNativeOptions<T> {
  model?: string;
  outputSchema?: ZodType<T>;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: PermissionMode;
  agents?: Record<string, AgentDefinition>;
  mcpServers?: Record<string, McpServerConfig>;
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  settingSources?: SettingSource[];
  allowApiKeyBilling?: boolean;
}

export interface CodexOutputSchema<T> {
  jsonSchema: Record<string, unknown>;
  /** Second validation boundary after Codex applies the native JSON Schema. */
  parse(value: unknown): T;
}

export interface CodexNativeOptions<T> {
  model?: string;
  /** Adapter validates model/version-specific values; core only requires a nonempty string. */
  reasoningEffort?: string;
  sandbox?: CodexSandbox;
  approvalPolicy?: CodexApprovalPolicy;
  outputSchema?: CodexOutputSchema<T>;
}

export interface ClaudeCodeRunRequest<T = string> extends BoundedRunBase {
  harness: "claude-code";
  native?: ClaudeCodeNativeOptions<T>;
}

export interface CodexRunRequest<T = string> extends BoundedRunBase {
  harness: "codex";
  native?: CodexNativeOptions<T>;
}

export type HarnessRunRequest<T = string> = ClaudeCodeRunRequest<T> | CodexRunRequest<T>;
export type HarnessRunRequestFor<H extends Harness, T = string> = H extends "claude-code"
  ? ClaudeCodeRunRequest<T>
  : CodexRunRequest<T>;

export type HarnessRunProgress = { harness: Harness; atMs: number } & (
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

export type HarnessRunResult<T = string, H extends Harness = Harness> =
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

export interface HarnessAdapter<H extends Harness> {
  descriptor: HarnessCapabilityDescriptor<H>;
  run<T>(request: HarnessRunRequestFor<H, T>): Promise<HarnessRunResult<T, H>>;
}
