import type {
  AgentDefinition,
  HookCallbackMatcher,
  HookEvent,
  McpServerConfig,
  PermissionMode,
  SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type { ZodType } from "zod";

export type Harness = "claude-code" | "codex";

/** Harnesses `runAgent` can drive. `claude-print` is headless `claude -p` on the CLI's own login. */
export type AgentRunHarness = "claude-code" | "claude-print";

/** `AgentRunConfig` fields claude-print cannot honour: it runs with no tools, hooks, MCP or resume. */
export const CLAUDE_PRINT_UNSUPPORTED_OPTIONS = [
  "allowedTools",
  "disallowedTools",
  "permissionMode",
  "resumeSessionId",
  "agents",
  "mcpServers",
  "hooks",
] as const;

export const CODEX_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"] as const;
export const CODEX_APPROVAL_POLICIES = ["untrusted", "on-failure", "on-request", "never"] as const;
export type CodexSandbox = (typeof CODEX_SANDBOXES)[number];
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];

/** SDK-free contracts are canonical in agent-protocol; aliases preserve legacy defaults. */
export { EXECUTION_CAPABILITIES } from "@titan-design/agent-protocol/harness";
export type {
  CapabilityAssessment, ExecutionCapability, ExecutionLimit, HarnessRunFailure, HarnessRunOutput,
  LimitCapability, LimitEnforcement, LimitScope, LimitUnit, OptionalLimitUnit, RunTarget, TranscriptSourceHint,
} from "@titan-design/agent-protocol/harness";
import type * as Protocol from "@titan-design/agent-protocol/harness";
export type BoundedRunBase = Protocol.BoundedRunBase<Harness>;
export type HarnessRunProgress = Protocol.HarnessRunProgress<Harness>;
export type HarnessCapabilityDescriptor<H extends string = Harness> = Protocol.HarnessCapabilityDescriptor<H>;
export type HarnessRunResult<T = string, H extends Harness = Harness> = Protocol.HarnessRunResult<T, H>;

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

export interface HarnessAdapter<H extends Harness> {
  descriptor: HarnessCapabilityDescriptor<H>;
  run<T>(request: HarnessRunRequestFor<H, T>): Promise<HarnessRunResult<T, H>>;
}
