import { PermissionMode, AgentDefinition, McpServerConfig, HookEvent, HookCallbackMatcher, SettingSource, SDKMessage, ModelUsage, query, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { ZodType, ZodError } from 'zod';
import { ConversationIdentity, ExecutionIdentity, UsageMeasurement, ExecutionRecord, ExecutionTerminal, AgentIdentity, ExecutionReconcileOutcome } from '@titan-design/agent-protocol';
import { ExecutionLedger } from '@titan-design/agent-lifecycle';

type Harness = "claude-code" | "codex";
/** Harnesses `runAgent` can drive. `claude-print` is headless `claude -p` on the CLI's own login. */
type AgentRunHarness = "claude-code" | "claude-print";
/** `AgentRunConfig` fields claude-print cannot honour: it runs with no tools, hooks, MCP or resume. */
declare const CLAUDE_PRINT_UNSUPPORTED_OPTIONS: readonly ["allowedTools", "disallowedTools", "permissionMode", "resumeSessionId", "agents", "mcpServers", "hooks"];
declare const CODEX_SANDBOXES: readonly ["read-only", "workspace-write", "danger-full-access"];
declare const CODEX_APPROVAL_POLICIES: readonly ["untrusted", "on-failure", "on-request", "never"];
type CodexSandbox = (typeof CODEX_SANDBOXES)[number];
type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];
declare const EXECUTION_CAPABILITIES: readonly ["fresh_run", "resume", "fork", "structured_output", "interactive_approvals", "external_cancellation", "semantic_interrupt", "active_turn_steering", "idle_turn_submission", "persisted_transcript", "process_reattachment", "token_reporting"];
type ExecutionCapability = (typeof EXECUTION_CAPABILITIES)[number];
type CapabilityAssessment = {
    status: "supported";
    evidence: string;
} | {
    status: "unsupported" | "unverified";
    reason: string;
};
type LimitUnit = "milliseconds" | "usd" | "model_requests" | "agent_iterations" | "tokens";
type OptionalLimitUnit = Exclude<LimitUnit, "milliseconds">;
type LimitScope = "execution" | "conversation";
type LimitEnforcement = "hard" | "advisory";
interface ExecutionLimit {
    unit: OptionalLimitUnit;
    value: number;
    scope: LimitScope;
    enforcement: LimitEnforcement;
}
interface LimitCapability {
    unit: LimitUnit;
    scope: LimitScope;
    enforcement: LimitEnforcement;
    assessment: CapabilityAssessment;
}
/** A factual report supplied by an adapter implementation, not a promise made by the core. */
interface HarnessCapabilityDescriptor<H extends string = Harness> {
    harness: H;
    adapter: {
        name: string;
        version: string;
    };
    capabilities: Record<ExecutionCapability, CapabilityAssessment>;
    limits: readonly LimitCapability[];
}
type RunTarget = {
    kind: "fresh";
    namespace: string;
} | {
    kind: "resume";
    conversation: ConversationIdentity;
};
interface BoundedRunBase {
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
interface ClaudeCodeNativeOptions<T> {
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
interface CodexOutputSchema<T> {
    jsonSchema: Record<string, unknown>;
    /** Second validation boundary after Codex applies the native JSON Schema. */
    parse(value: unknown): T;
}
interface CodexNativeOptions<T> {
    model?: string;
    /** Adapter validates model/version-specific values; core only requires a nonempty string. */
    reasoningEffort?: string;
    sandbox?: CodexSandbox;
    approvalPolicy?: CodexApprovalPolicy;
    outputSchema?: CodexOutputSchema<T>;
}
interface ClaudeCodeRunRequest<T = string> extends BoundedRunBase {
    harness: "claude-code";
    native?: ClaudeCodeNativeOptions<T>;
}
interface CodexRunRequest<T = string> extends BoundedRunBase {
    harness: "codex";
    native?: CodexNativeOptions<T>;
}
type HarnessRunRequest<T = string> = ClaudeCodeRunRequest<T> | CodexRunRequest<T>;
type HarnessRunRequestFor<H extends Harness, T = string> = H extends "claude-code" ? ClaudeCodeRunRequest<T> : CodexRunRequest<T>;
type HarnessRunProgress = {
    harness: Harness;
    atMs: number;
} & ({
    kind: "execution_started";
    execution: ExecutionIdentity;
} | {
    kind: "conversation_identified";
    executionId: string;
    conversation: ConversationIdentity;
} | {
    kind: "assistant_output";
    executionId: string;
    text: string;
} | {
    kind: "usage";
    executionId: string;
    measurement: UsageMeasurement;
} | {
    kind: "execution_finished";
    executionId: string;
    outcome: "succeeded" | "failed" | "cancelled";
});
type HarnessRunOutput<T> = {
    kind: "text";
    text: string;
} | {
    kind: "structured";
    value: T;
};
interface TranscriptSourceHint {
    format: string;
    namespace: string;
    path?: string;
}
type HarnessRunFailure = {
    kind: "invalid_request";
    reason: string;
} | {
    kind: "harness_mismatch";
    reason: string;
} | {
    kind: "unsupported_requirement";
    reason: string;
    requirement: {
        kind: "capability";
        capability: ExecutionCapability;
    } | {
        kind: "limit";
        limit: LimitCapability;
    };
    status: "unsupported" | "unverified";
} | {
    kind: "rate_limited";
    reason: string;
    retryAtMs?: number;
    native?: unknown;
} | {
    kind: "limit_exceeded";
    reason: string;
    unit: LimitUnit;
    native?: unknown;
} | {
    kind: "output_invalid";
    reason: string;
    native?: unknown;
} | {
    kind: "auth_misconfigured";
    reason: string;
    native?: unknown;
} | {
    kind: "aborted";
    reason: string;
} | {
    kind: "wall_time_exceeded";
    reason: string;
    wallTimeMs: number;
} | {
    kind: "cancelled_unknown";
    reason: string;
    native?: unknown;
} | {
    kind: "runtime_error";
    reason: string;
    native?: unknown;
};
type HarnessRunResult<T = string, H extends Harness = Harness> = {
    ok: true;
    harness: H;
    execution: ExecutionIdentity;
    conversation: ConversationIdentity;
    output: HarnessRunOutput<T>;
    usage: readonly UsageMeasurement[];
    transcript?: TranscriptSourceHint;
} | {
    ok: false;
    harness: H;
    execution?: ExecutionIdentity;
    conversation?: ConversationIdentity;
    failure: HarnessRunFailure;
    usage: readonly UsageMeasurement[];
};
interface HarnessAdapter<H extends Harness> {
    descriptor: HarnessCapabilityDescriptor<H>;
    run<T>(request: HarnessRunRequestFor<H, T>): Promise<HarnessRunResult<T, H>>;
}

/** Why a run ended without a usable answer. One kind per recovery strategy. */
type AgentFailure = {
    kind: "rate_limited";
    reason: string;
    retryAt?: Date;
    raw?: unknown;
} | {
    kind: "budget_exceeded";
    reason: string;
    raw?: unknown;
} | {
    kind: "schema_invalid";
    reason: string;
    error?: ZodError;
    raw?: unknown;
} | {
    kind: "max_turns";
    reason: string;
    raw?: unknown;
} | {
    kind: "refusal";
    reason: string;
    raw?: unknown;
} | {
    kind: "auth_misconfigured";
    reason: string;
    hint?: string;
    raw?: unknown;
} | {
    kind: "runtime_error";
    reason: string;
    raw?: unknown;
} | {
    kind: "aborted";
    reason: string;
} | {
    kind: "inactivity_timeout";
    reason: string;
    timeoutMs: number;
};
type AgentFailureKind = AgentFailure["kind"];
/** What the first `system/init` message told us about the session we actually got. */
interface AgentInit {
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
interface AgentUsage {
    totalCostUsd: number;
    modelUsage: Record<string, ModelUsage>;
    turns: number;
    durationMs: number;
}
interface AgentRunConfig<T = string> {
    /** Defaults to `claude-code` (the SDK). `claude-print` spawns `claude -p` and needs no `CLAUDE_CODE_OAUTH_TOKEN`. */
    harness?: AgentRunHarness;
    prompt: string;
    cwd: string;
    /** Required: the SDK's own default is unlimited. Must be positive. */
    maxTurns: number;
    /** Required: the SDK's own default is unlimited. Must be positive. */
    maxBudgetUsd: number;
    model?: string;
    /** Turns on the SDK's `json_schema` output format, which retries on its own until the answer validates. */
    outputSchema?: ZodType<T>;
    /** The built-in tool set; `[]` runs with no tools at all. Omitted keeps the SDK default. */
    tools?: string[];
    allowedTools?: string[];
    disallowedTools?: string[];
    /** Replaces the SDK's default Claude Code system prompt. */
    systemPrompt?: string;
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
type AgentRunResult<T = string> = {
    ok: true;
    output: T;
    sessionId: string;
    usage: AgentUsage;
    init: AgentInit;
} | {
    ok: false;
    failure: AgentFailure;
    sessionId?: string;
    usage?: AgentUsage;
};

declare const DEFAULT_INACTIVITY_MS = 600000;
interface AgentRunDeps {
    /** Injection seam for tests; defaults to the SDK's own `query`. */
    query?: typeof query;
    /** Base environment to scrub; defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
    now?: () => number;
}
/**
 * Run one headless Claude Code session to completion and return either its
 * answer or a typed failure. Never throws for anything the agent does; the only
 * throws are caller mistakes caught before the session starts.
 */
declare function runAgent<T = string>(config: AgentRunConfig<T>, deps?: AgentRunDeps): Promise<AgentRunResult<T>>;

/** SIGTERM alone has been ignored by the CLI in the repo-review pipeline, so SIGKILL follows. */
declare const CLAUDE_PRINT_KILL_GRACE_MS = 5000;
declare function claudePrintCapabilities(): HarnessCapabilityDescriptor<"claude-print">;
/** The first executable file named `claude` on PATH, never a shell function or alias. `CLAUDE_BIN` wins. */
declare function resolveClaudeBin(env: Record<string, string>): string | undefined;
declare function buildClaudePrintArgs(config: AgentRunConfig<unknown>): string[];

declare function preflightHarnessRun<H extends Harness, T>(request: HarnessRunRequestFor<H, T>, descriptor: HarnessCapabilityDescriptor<H>): HarnessRunFailure | undefined;
declare function dispatchHarnessRun<H extends Harness, T>(request: HarnessRunRequestFor<H, T>, adapter: HarnessAdapter<H>): Promise<HarnessRunResult<T, H>>;

/**
 * One dated rate row for a Codex model, in USD per million tokens. The package
 * ships no rows: pricing is product policy, and a checked-in table would go stale.
 */
interface CodexPriceRow {
    model: string;
    /** UTC date (YYYY-MM-DD) from which this row applies. */
    effectiveFrom: string;
    inputUsdPerMTok: number;
    cachedInputUsdPerMTok: number;
    outputUsdPerMTok: number;
}
/** Fills `cost` on measurements whose model has a row in force at `atMs`; others keep `cost: null`. */
declare function priceCodexUsage(measurements: readonly UsageMeasurement[], prices: readonly CodexPriceRow[], atMs: number): UsageMeasurement[];

interface CodexProcessExit {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
}
interface SupervisedCodexProcess {
    stdout: AsyncIterable<string>;
    stderr: AsyncIterable<string>;
    completed: Promise<CodexProcessExit>;
    terminate(signal: "SIGTERM" | "SIGKILL"): void;
}
interface CodexSchemaFile {
    path: string;
    dispose(): Promise<void>;
}
interface CodexProcessInput {
    executablePath: string;
    args: readonly string[];
    cwd: string;
    env: Record<string, string>;
}
interface CodexVersionInspectionOptions {
    signal?: AbortSignal;
    timeoutMs: number;
}

declare const MIN_CODEX_EXEC_VERSION = "0.162.1";
declare const CODEX_RUNTIME_CAPABILITIES: readonly ["json_events", "config_overrides", "user_config_isolation", "strict_config", "output_schema", "model_selection", "working_directory", "mcp_config", "tool_policy", "rollout_rate_limits"];
type CodexRuntimeCapability = (typeof CODEX_RUNTIME_CAPABILITIES)[number];
/** Only explicit true is evidence. Missing/unknown capabilities fail a requirement. */
interface CodexRuntimeInspection {
    capabilities: Partial<Record<CodexRuntimeCapability, boolean>>;
    sandboxes: readonly string[];
}
interface CodexCapabilityInspectionOptions extends CodexVersionInspectionOptions {
    resume: boolean;
}
/** Model-free surface probe; it never starts a turn, app-server, or MCP server. */
declare function inspectCodexCapabilities(executablePath: string, env: Record<string, string>, options: CodexCapabilityInspectionOptions): Promise<CodexRuntimeInspection>;

declare const DEFAULT_CODEX_EXECUTABLE = "codex";
interface CodexAvailabilityOptions {
    executablePath?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    signal?: AbortSignal;
    resume?: boolean;
    sandbox?: string;
    requiredCapabilities?: readonly CodexRuntimeCapability[];
}
interface CodexAvailabilityDeps {
    inspectVersion?: (path: string, env: Record<string, string>, options: CodexVersionInspectionOptions) => Promise<string>;
    inspectCapabilities?: (path: string, env: Record<string, string>, options: CodexCapabilityInspectionOptions) => Promise<CodexRuntimeInspection>;
}
type CodexAvailability = {
    ok: true;
    executablePath: string;
    versionOutput: string;
    inspection: CodexRuntimeInspection;
} | {
    ok: false;
    failure: HarnessRunFailure;
};
/** Model-free runtime admission only; cached login and policy enforcement are separate. */
declare function checkCodexAvailable(options?: CodexAvailabilityOptions, deps?: CodexAvailabilityDeps): Promise<CodexAvailability>;

/** @deprecated This is the minimum floor, not an exact version pin. */
declare const SUPPORTED_CODEX_EXEC_VERSION = "0.162.1";
declare const STRIPPED_CODEX_AUTH_VARS: readonly ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN"];
interface CodexExecAdapterOptions {
    auth: "cached-cli";
    executablePath?: string;
    env?: NodeJS.ProcessEnv;
    killGraceMs?: number;
    /** Dated rates used to estimate turn cost; without a row for the model, cost stays null. */
    prices?: readonly CodexPriceRow[];
    /** Extra runtime requirements, e.g. MCP/policy/rollout evidence for a managed peer. */
    requiredRuntimeCapabilities?: readonly CodexRuntimeCapability[];
}
interface CodexExecDeps {
    inspectCapabilities?: (executablePath: string, env: Record<string, string>, options: CodexCapabilityInspectionOptions) => Promise<CodexRuntimeInspection>;
    inspectVersion?: (executablePath: string, env: Record<string, string>, options: CodexVersionInspectionOptions) => Promise<string>;
    start?: (input: CodexProcessInput) => SupervisedCodexProcess;
    createSchemaFile?: (schema: Record<string, unknown>) => Promise<CodexSchemaFile>;
    executionId?: () => string;
    now?: () => number;
    deadlineNow?: () => number;
}
declare function createCodexExecAdapter(options: CodexExecAdapterOptions, deps?: CodexExecDeps): HarnessAdapter<"codex">;
declare function prepareCodexEnv(env: NodeJS.ProcessEnv): Record<string, string>;
declare function codexExecCapabilities(): HarnessCapabilityDescriptor<"codex">;
declare function buildCodexExecArgs<T>(request: CodexRunRequest<T>, schemaPath?: string): string[];

declare const DEFAULT_CODEX_KILL_GRACE_MS = 2000;

interface ClassifyOptions {
    /** Epoch millis used to turn a relative "retry after Ns" hint into an absolute date. */
    now?: number;
    /** Epoch millis from the stream's last `rate_limit_event`, which beats anything parsed from prose. */
    rateLimitResetsAt?: number;
}
/**
 * Map a terminal `result` message onto the failure taxonomy, or `undefined` when
 * the run succeeded and the caller should read the output.
 */
declare function classifyResult(result: SDKResultMessage, options?: ClassifyOptions): AgentFailure | undefined;
/**
 * The SDK's cost fields are already cumulative across a `query()` call, so the
 * latest result carries the running total and summing them would double-count.
 * `modelUsage` is the fallback because a crash result can arrive with
 * `total_cost_usd` zeroed while the per-model breakdown survives.
 */
declare function usageFromResult(result: SDKResultMessage | undefined, durationMs: number): AgentUsage;
declare function sumModelCost(modelUsage: Record<string, ModelUsage>): number;

/**
 * The only module in this package that reads `process.env`. A stray
 * `ANTHROPIC_API_KEY` silently outranks `CLAUDE_CODE_OAUTH_TOKEN` and routes a
 * headless run onto metered API billing; the invariants here exist because that
 * cost real money once.
 */
/** Set by a parent Claude Code session; the child CLI refuses to start when it inherits them. */
declare const ANTI_NESTING_VARS: readonly ["CLAUDECODE", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_ENTRYPOINT"];
/** Metered-billing credentials, stripped unless the caller opts in explicitly. */
declare const STRIPPED_AUTH_VARS: readonly ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
/**
 * The only `CLAUDE_CODE_*` variables a child may inherit. Everything else in
 * that namespace describes the *parent* session (exec path, terminal, entry
 * point) and confuses the child's credential and config inference.
 */
declare const CLAUDE_CODE_PASSTHROUGH_VARS: readonly ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_MAX_RETRIES", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"];
/** Proxy settings leak from the parent shell and silently re-route the child's API traffic. */
declare const STRIPPED_PROXY_VARS: readonly ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];
/** The CLI retries 10 times by default, which turns an outage into a long silent hang. */
declare const DEFAULT_MAX_RETRIES = "3";
interface PrepareEnvOptions {
    /** Leave `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in place and bill the API account. */
    allowApiKeyBilling?: boolean;
}
interface AuthEnvCheckOptions extends PrepareEnvOptions {
    /** Defaults to true. The claude-print harness sets it false: the CLI's own keychain login is its credential. */
    requireOAuthToken?: boolean;
}
declare class AuthMisconfiguredError extends Error {
    readonly hint: string | undefined;
    constructor(message: string, hint?: string);
}
/**
 * Copy `env` and scrub it into something safe to hand a child Claude Code
 * process. Never mutates its argument, so the result can go straight to
 * `options.env`.
 */
declare function prepareEnv(env?: NodeJS.ProcessEnv, options?: PrepareEnvOptions): Record<string, string>;
/**
 * Pre-flight the scrubbed env so a misrouted run fails before it spends
 * anything, rather than mid-stream with a surprise billing source.
 */
declare function assertAuthEnvOk(env: Record<string, string>, options?: AuthEnvCheckOptions): void;
/**
 * Credential sources that mean the run went to metered API billing. A blacklist,
 * not a whitelist: the SDK's `ApiKeySource` union grows, and an unrecognised new
 * member is far more likely to be another benign OAuth-ish route than a billing
 * one. `"env"` is the pre-0.3 spelling of `"ANTHROPIC_API_KEY"`, kept so an
 * older CLI on the PATH still trips the guard.
 */
declare const FORBIDDEN_API_KEY_SOURCES: ReadonlySet<string>;
/** Post-flight on the first `system/init`, the earliest point the real auth route is observable. */
declare function assertApiKeySourceAllowed(observed: string | undefined): void;

interface DurableHarnessSuccess<T = unknown, H extends Harness = Harness> {
    harness: H;
    adapterExecution: ExecutionIdentity;
    conversation: ConversationIdentity;
    output: HarnessRunOutput<T>;
    usage: readonly UsageMeasurement[];
    transcript?: TranscriptSourceHint;
}
type DurableHarnessRecord<H extends Harness = Harness> = ExecutionRecord<DurableHarnessSuccess<unknown, H>>;
type DurableSettlement<T = unknown, H extends Harness = Harness> = {
    kind: "terminal";
    record: ExecutionRecord<DurableHarnessSuccess<T, H>>;
    terminal: ExecutionTerminal<DurableHarnessSuccess<T, H>>;
} | {
    kind: "recovery_required";
    record: DurableHarnessRecord<H>;
    evidence: string;
} | {
    kind: "ownership_lost";
    record?: DurableHarnessRecord<H>;
    evidence: string;
};
interface DurableDispatchInput<H extends Harness, T = string> {
    executionId: string;
    requestKey: string;
    agent?: AgentIdentity;
    request: HarnessRunRequestFor<H, T>;
}
interface DurableDispatchAck<T = unknown, H extends Harness = Harness> {
    executionId: string;
    requestKey: string;
    runnerRef: string;
    completion: Promise<DurableSettlement<T, H>>;
}
interface DurableLiveHandle<T = unknown, H extends Harness = Harness> {
    runnerRef: string;
    completion: Promise<DurableSettlement<T, H>>;
}
type DurableReconcileOutcome<H extends Harness = Harness> = ExecutionReconcileOutcome<DurableHarnessSuccess<unknown, H>, DurableLiveHandle<unknown, H>>;
type DurableCancelResult<H extends Harness = Harness> = {
    kind: "requested";
    record: DurableHarnessRecord<H>;
} | {
    kind: "not_live";
    evidence: string;
} | {
    kind: "ownership_lost";
    record?: DurableHarnessRecord<H>;
    evidence: string;
};
interface DurableHarnessDispatcher<H extends Harness> {
    readonly adapter: HarnessAdapter<H>;
    dispatch<T>(input: DurableDispatchInput<H, T>): Promise<DurableDispatchAck<T, H>>;
    reconcile(executionId: string): Promise<DurableReconcileOutcome<H>>;
    cancel(executionId: string, reason: string): DurableCancelResult<H>;
}
interface DurableHarnessDispatcherOptions<H extends Harness> {
    ledger: ExecutionLedger<DurableHarnessSuccess<unknown, H>>;
    supervisorId: string;
    leaseMs: number;
    renewEveryMs?: number;
}
interface DurableHarnessDispatcherDeps {
    eventId?: () => string;
    now?: () => number;
    setInterval?: typeof globalThis.setInterval;
    clearInterval?: typeof globalThis.clearInterval;
}

declare function createDurableHarnessDispatcher<H extends Harness>(adapter: DurableHarnessDispatcher<H>["adapter"], options: DurableHarnessDispatcherOptions<H>, deps?: DurableHarnessDispatcherDeps): DurableHarnessDispatcher<H>;

interface ClaudeCodeAdapterOptions {
    maxTurns: number;
    maxBudgetUsd: number;
    inactivityTimeoutMs?: number;
    deps?: AgentRunDeps;
}
/** Existing Claude query circuit breakers remain mandatory; their native units stay explicit. */
declare function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions): HarnessAdapter<"claude-code">;
declare function claudeCodeCapabilities(): HarnessCapabilityDescriptor<"claude-code">;

export { ANTI_NESTING_VARS, type AgentFailure, type AgentFailureKind, type AgentInit, type AgentRunConfig, type AgentRunDeps, type AgentRunHarness, type AgentRunResult, type AgentUsage, type AuthEnvCheckOptions, AuthMisconfiguredError, type BoundedRunBase, CLAUDE_CODE_PASSTHROUGH_VARS, CLAUDE_PRINT_KILL_GRACE_MS, CLAUDE_PRINT_UNSUPPORTED_OPTIONS, CODEX_APPROVAL_POLICIES, CODEX_RUNTIME_CAPABILITIES, CODEX_SANDBOXES, type CapabilityAssessment, type ClassifyOptions, type ClaudeCodeAdapterOptions, type ClaudeCodeNativeOptions, type ClaudeCodeRunRequest, type CodexApprovalPolicy, type CodexAvailability, type CodexAvailabilityDeps, type CodexAvailabilityOptions, type CodexCapabilityInspectionOptions, type CodexExecAdapterOptions, type CodexExecDeps, type CodexNativeOptions, type CodexOutputSchema, type CodexPriceRow, type CodexProcessExit, type CodexProcessInput, type CodexRunRequest, type CodexRuntimeCapability, type CodexRuntimeInspection, type CodexSandbox, type CodexSchemaFile, type CodexVersionInspectionOptions, DEFAULT_CODEX_EXECUTABLE, DEFAULT_CODEX_KILL_GRACE_MS, DEFAULT_INACTIVITY_MS, DEFAULT_MAX_RETRIES, type DurableCancelResult, type DurableDispatchAck, type DurableDispatchInput, type DurableHarnessDispatcher, type DurableHarnessDispatcherDeps, type DurableHarnessDispatcherOptions, type DurableHarnessRecord, type DurableHarnessSuccess, type DurableLiveHandle, type DurableReconcileOutcome, type DurableSettlement, EXECUTION_CAPABILITIES, type ExecutionCapability, type ExecutionLimit, FORBIDDEN_API_KEY_SOURCES, type Harness, type HarnessAdapter, type HarnessCapabilityDescriptor, type HarnessRunFailure, type HarnessRunOutput, type HarnessRunProgress, type HarnessRunRequest, type HarnessRunRequestFor, type HarnessRunResult, type LimitCapability, type LimitEnforcement, type LimitScope, type LimitUnit, MIN_CODEX_EXEC_VERSION, type OptionalLimitUnit, type PrepareEnvOptions, type RunTarget, STRIPPED_AUTH_VARS, STRIPPED_CODEX_AUTH_VARS, STRIPPED_PROXY_VARS, SUPPORTED_CODEX_EXEC_VERSION, type SupervisedCodexProcess, type TranscriptSourceHint, assertApiKeySourceAllowed, assertAuthEnvOk, buildClaudePrintArgs, buildCodexExecArgs, checkCodexAvailable, classifyResult, claudeCodeCapabilities, claudePrintCapabilities, codexExecCapabilities, createClaudeCodeAdapter, createCodexExecAdapter, createDurableHarnessDispatcher, dispatchHarnessRun, inspectCodexCapabilities, preflightHarnessRun, prepareCodexEnv, prepareEnv, priceCodexUsage, resolveClaudeBin, runAgent, sumModelCost, usageFromResult };
