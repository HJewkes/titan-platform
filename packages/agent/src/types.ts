import type {
  AgentDefinition,
  HookCallbackMatcher,
  HookEvent,
  McpServerConfig,
  ModelUsage,
  PermissionMode,
  SDKMessage,
  SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type { ZodError, ZodType } from "zod";

/** Why a run ended without a usable answer. One kind per recovery strategy. */
export type AgentFailure =
  | { kind: "rate_limited"; reason: string; retryAt?: Date; raw?: unknown }
  | { kind: "budget_exceeded"; reason: string; raw?: unknown }
  | { kind: "schema_invalid"; reason: string; error?: ZodError; raw?: unknown }
  | { kind: "max_turns"; reason: string; raw?: unknown }
  | { kind: "refusal"; reason: string; raw?: unknown }
  | { kind: "auth_misconfigured"; reason: string; hint?: string; raw?: unknown }
  | { kind: "runtime_error"; reason: string; raw?: unknown }
  | { kind: "aborted"; reason: string }
  | { kind: "inactivity_timeout"; reason: string; timeoutMs: number };

export type AgentFailureKind = AgentFailure["kind"];

/** What the first `system/init` message told us about the session we actually got. */
export interface AgentInit {
  apiKeySource: string | undefined;
  model: string | undefined;
  tools: string[];
  permissionMode: string | undefined;
  claudeCodeVersion: string | undefined;
}

/**
 * Client-side estimates. The SDK prices from a bundled table, so treat these as
 * a budget signal and never as a billing statement.
 */
export interface AgentUsage {
  totalCostUsd: number;
  modelUsage: Record<string, ModelUsage>;
  turns: number;
  durationMs: number;
}

export interface AgentRunConfig<T = string> {
  prompt: string;
  cwd: string;
  /** Required: the SDK's own default is unlimited. Must be positive. */
  maxTurns: number;
  /** Required: the SDK's own default is unlimited. Must be positive. */
  maxBudgetUsd: number;
  model?: string;
  /** Turns on the SDK's `json_schema` output format, which retries on its own until the answer validates. */
  outputSchema?: ZodType<T>;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Defaults to `dontAsk`: nothing is pre-approved, so nothing runs unprompted. */
  permissionMode?: PermissionMode;
  resumeSessionId?: string;
  agents?: Record<string, AgentDefinition>;
  mcpServers?: Record<string, McpServerConfig>;
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  signal?: AbortSignal;
  /** Ends the run when no message arrives for this long. Defaults to 600_000. */
  inactivityTimeoutMs?: number;
  /** Keeps `ANTHROPIC_API_KEY` in the child env and bills the API account. */
  allowApiKeyBilling?: boolean;
  /** Defaults to `[]`: nothing is read off the filesystem unless asked for. */
  settingSources?: SettingSource[];
  onMessage?: (message: SDKMessage) => void;
}

export type AgentRunResult<T = string> =
  | { ok: true; output: T; sessionId: string; usage: AgentUsage; init: AgentInit }
  | { ok: false; failure: AgentFailure; sessionId?: string; usage?: AgentUsage };
