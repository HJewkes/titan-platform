import { PermissionMode, AgentDefinition, McpServerConfig, HookEvent, HookCallbackMatcher, SettingSource, SDKMessage, ModelUsage, query, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { ZodType, ZodError } from 'zod';
import * as Protocol from '@titan-design/agent-protocol/harness';
import { HarnessRunFailure, HarnessPricingPort, HarnessRunOutput, TranscriptSourceHint } from '@titan-design/agent-protocol/harness';
export { CapabilityAssessment, EXECUTION_CAPABILITIES, ExecutionCapability, ExecutionLimit, HarnessRunFailure, HarnessRunOutput, LimitCapability, LimitEnforcement, LimitScope, LimitUnit, OptionalLimitUnit, RunTarget, TranscriptSourceHint } from '@titan-design/agent-protocol/harness';
import { CodexPriceRow } from '@titan-design/agent-protocol/pricing';
export { CodexPriceRow, priceCodexUsage } from '@titan-design/agent-protocol/pricing';
import { ExecutionLedger } from '@titan-design/agent-lifecycle';
import { ExecutionRecord, ExecutionIdentity, ConversationIdentity, UsageMeasurement, ExecutionTerminal, AgentIdentity, ExecutionReconcileOutcome } from '@titan-design/agent-protocol';

type Harness = "claude-code" | "codex";
/** Harnesses `runAgent` can drive. `claude-print` is headless `claude -p` on the CLI's own login. */
type AgentRunHarness = "claude-code" | "claude-print";
/** `AgentRunConfig` fields claude-print cannot honour: it runs with no tools, hooks, MCP or resume. */
declare const CLAUDE_PRINT_UNSUPPORTED_OPTIONS: readonly ["allowedTools", "disallowedTools", "permissionMode", "resumeSessionId", "agents", "mcpServers", "hooks"];
declare const CODEX_SANDBOXES: readonly ["read-only", "workspace-write", "danger-full-access"];
declare const CODEX_APPROVAL_POLICIES: readonly ["untrusted", "on-failure", "on-request", "never"];
type CodexSandbox = (typeof CODEX_SANDBOXES)[number];
type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];

type BoundedRunBase = Protocol.BoundedRunBase<Harness>;
type HarnessRunProgress = Protocol.HarnessRunProgress<Harness>;
type HarnessCapabilityDescriptor<H extends string = Harness> = Protocol.HarnessCapabilityDescriptor<H>;
type HarnessRunResult<T = string, H extends Harness = Harness> = Protocol.HarnessRunResult<T, H>;
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
    /** Optional pure quote service; mutually exclusive with prices. */
    pricingService?: HarnessPricingPort<"codex">;
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

type CodexUserInput = {
    type: "text";
    text: string;
} | {
    type: "localImage";
    path: string;
};
interface CodexAppServerOptions {
    cwd: string;
    env: Record<string, string>;
    executablePath?: string;
    /** Replaces `["app-server"]`, for `-c` overrides or a stand-in server. */
    args?: readonly string[];
    clientInfo?: {
        name: string;
        version: string;
    };
}
interface CodexInitializeResult {
    userAgent: string;
    codexHome: string;
    platformFamily: string;
    platformOs: string;
}
interface CodexThreadOptions {
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    developerInstructions?: string;
    config?: Record<string, unknown>;
}
interface CodexThreadResult {
    threadId: string;
    model: string;
    cwd: string;
    /** The full thread/start or thread/resume result, for fields this client does not type. */
    raw: Record<string, unknown>;
}
interface CodexTurnStartParams {
    threadId: string;
    input: readonly CodexUserInput[];
    clientUserMessageId?: string;
}
interface CodexTurnSteerParams extends CodexTurnStartParams {
    expectedTurnId: string;
}
declare const TURN_STATUSES: readonly ["completed", "interrupted", "failed", "inProgress"];
declare const THREAD_STATUSES: readonly ["notLoaded", "idle", "systemError", "active"];
type CodexTurnStatus = (typeof TURN_STATUSES)[number];
type CodexThreadStatus = (typeof THREAD_STATUSES)[number];
type CodexAppServerEvent = {
    kind: "turn_started";
    threadId: string;
    turnId: string;
} | {
    kind: "turn_completed";
    threadId: string;
    turnId: string;
    status: CodexTurnStatus;
} | {
    kind: "thread_status";
    threadId: string;
    status: CodexThreadStatus;
    activeFlags: readonly string[];
} | {
    kind: "notification";
    method: string;
    params: unknown;
} | ({
    kind: "exit";
    stderrTail: string;
} & CodexProcessExit);
interface CodexAppServer {
    readonly initialized: CodexInitializeResult;
    readonly exited: Promise<CodexProcessExit>;
    threadStart(options?: CodexThreadOptions): Promise<CodexThreadResult>;
    threadResume(threadId: string, options?: CodexThreadOptions): Promise<CodexThreadResult>;
    turnStart(params: CodexTurnStartParams): Promise<{
        turnId: string;
    }>;
    /** Rejects with CodexSteerPreconditionError when no turn, or another turn, is active. */
    turnSteer(params: CodexTurnSteerParams): Promise<{
        turnId: string;
    }>;
    onEvent(listener: (event: CodexAppServerEvent) => void): () => void;
    close(signal?: NodeJS.Signals): Promise<CodexProcessExit>;
}
declare class CodexAppServerRpcError extends Error {
    readonly method: string;
    readonly code: number;
    readonly data?: unknown | undefined;
    constructor(method: string, code: number, message: string, data?: unknown | undefined);
}
/** The turn ended, or a different one is active, before the steer arrived; fall back to turnStart. */
declare class CodexSteerPreconditionError extends CodexAppServerRpcError {
    name: string;
}
declare class CodexAppServerExitedError extends Error {
    readonly method: string;
    readonly exit: CodexProcessExit;
    constructor(method: string, exit: CodexProcessExit);
}
declare function startCodexAppServer(options: CodexAppServerOptions): Promise<CodexAppServer>;

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

export { ANTI_NESTING_VARS, type AgentFailure, type AgentFailureKind, type AgentInit, type AgentRunConfig, type AgentRunDeps, type AgentRunHarness, type AgentRunResult, type AgentUsage, type AuthEnvCheckOptions, AuthMisconfiguredError, type BoundedRunBase, CLAUDE_CODE_PASSTHROUGH_VARS, CLAUDE_PRINT_KILL_GRACE_MS, CLAUDE_PRINT_UNSUPPORTED_OPTIONS, CODEX_APPROVAL_POLICIES, CODEX_RUNTIME_CAPABILITIES, CODEX_SANDBOXES, type ClassifyOptions, type ClaudeCodeAdapterOptions, type ClaudeCodeNativeOptions, type ClaudeCodeRunRequest, type CodexAppServer, type CodexAppServerEvent, CodexAppServerExitedError, type CodexAppServerOptions, CodexAppServerRpcError, type CodexApprovalPolicy, type CodexAvailability, type CodexAvailabilityDeps, type CodexAvailabilityOptions, type CodexCapabilityInspectionOptions, type CodexExecAdapterOptions, type CodexExecDeps, type CodexInitializeResult, type CodexNativeOptions, type CodexOutputSchema, type CodexProcessExit, type CodexProcessInput, type CodexRunRequest, type CodexRuntimeCapability, type CodexRuntimeInspection, type CodexSandbox, type CodexSchemaFile, CodexSteerPreconditionError, type CodexThreadOptions, type CodexThreadResult, type CodexThreadStatus, type CodexTurnStartParams, type CodexTurnStatus, type CodexTurnSteerParams, type CodexUserInput, type CodexVersionInspectionOptions, DEFAULT_CODEX_EXECUTABLE, DEFAULT_CODEX_KILL_GRACE_MS, DEFAULT_INACTIVITY_MS, DEFAULT_MAX_RETRIES, type DurableCancelResult, type DurableDispatchAck, type DurableDispatchInput, type DurableHarnessDispatcher, type DurableHarnessDispatcherDeps, type DurableHarnessDispatcherOptions, type DurableHarnessRecord, type DurableHarnessSuccess, type DurableLiveHandle, type DurableReconcileOutcome, type DurableSettlement, FORBIDDEN_API_KEY_SOURCES, type Harness, type HarnessAdapter, type HarnessCapabilityDescriptor, type HarnessRunProgress, type HarnessRunRequest, type HarnessRunRequestFor, type HarnessRunResult, MIN_CODEX_EXEC_VERSION, type PrepareEnvOptions, STRIPPED_AUTH_VARS, STRIPPED_CODEX_AUTH_VARS, STRIPPED_PROXY_VARS, SUPPORTED_CODEX_EXEC_VERSION, type SupervisedCodexProcess, assertApiKeySourceAllowed, assertAuthEnvOk, buildClaudePrintArgs, buildCodexExecArgs, checkCodexAvailable, classifyResult, claudeCodeCapabilities, claudePrintCapabilities, codexExecCapabilities, createClaudeCodeAdapter, createCodexExecAdapter, createDurableHarnessDispatcher, dispatchHarnessRun, inspectCodexCapabilities, preflightHarnessRun, prepareCodexEnv, prepareEnv, resolveClaudeBin, runAgent, startCodexAppServer, sumModelCost, usageFromResult };
