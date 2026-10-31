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
    /** Cache writes by TTL from the result's raw `usage`, which is not broken out per model; absent when the harness gave no split. */
    cacheCreation?: {
        ephemeral5m: number;
        ephemeral1h: number;
    };
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
    /** The spawned app-server process id, also its process group id; for callers that record or reap it. */
    readonly pid: number;
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
declare function sumModelCost(modelUsage: Record<string, Partial<Pick<ModelUsage, "costUSD">>>): number;

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
declare const CLAUDE_CODE_PASSTHROUGH_VARS: readonly ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_MAX_RETRIES", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "CLAUDE_CODE_REMOTE"];
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

/**
 * CC-898: the variables that say which agent launch a process descends from.
 *
 * Only `run-agent`'s claude child and its descendants may carry them. The broker and everything
 * it starts (tmux, helpers) must not, or an orphan reaper keyed on them could not tell a stray
 * of a finished launch from infrastructure that merely inherited the identity of whichever
 * agent happened to auto-start the broker.
 */
declare const AGENT_ID_ENV = "AGENT_CHAT_AGENT_ID";
declare const LAUNCHER_PID_ENV = "AGENT_CHAT_LAUNCHER_PID";
declare const LAUNCH_IDENTITY_ENV: readonly ["AGENT_CHAT_AGENT_ID", "AGENT_CHAT_NAME", "AGENT_CHAT_LAUNCHER_PID"];
/** No `.`, `/` or `\`, so a valid agent name can never leave /tmp or name a parent. */
declare const AGENT_NAME_PATTERN = "[a-z0-9][a-z0-9_-]{0,63}";
declare const isLaunchTmpDir: (dir: string | undefined) => boolean;
declare function clearLaunchTmpDirs(env: NodeJS.ProcessEnv): void;
/**
 * TP-4347: a restart's owner token and its test seam belong to the one broker that restart
 * starts. Inherited, the token would let that broker's children outrank the lock too.
 */
declare const RESTART_TOKEN_ENV = "AGENT_CHAT_RESTART_TOKEN";
declare const RESTART_GAP_ENV = "AGENT_CHAT_TEST_RESTART_GAP_MS";
/** Removes the launch identity, any restart token and any launch's private temp dir from `env` in place. */
declare function clearLaunchIdentity(env: NodeJS.ProcessEnv): void;
declare function withoutLaunchIdentity(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/** The roster fields the orphan reap and the TMPDIR sweep read; a host's own row type satisfies it. */
interface LaunchRow {
    agentId: string;
    name: string;
    state: string;
    exitedAt?: number;
    lastEventAt: number;
}

/**
 * CC-898: kill what a finished headless agent left behind.
 *
 * A process belongs to a launch when its environment carries that launch's
 * `AGENT_CHAT_AGENT_ID` and `AGENT_CHAT_LAUNCHER_PID` together. The agent id alone is not
 * enough: a resume keeps it, so a name or id match could kill a live successor. The launcher
 * pid is `run-agent`'s own, which a relaunch never reuses while the old one still runs.
 *
 * The environment is read from /proc, which only Linux has. A process whose environ cannot
 * be read is skipped, never guessed at.
 */
/** How long a row stays exited or retired before the sweep trusts that its processes are strays. */
declare const SWEEP_GRACE_MS: number;
/** Between TERM and KILL. */
declare const KILL_GRACE_MS = 2000;
interface ProcessTable {
    pids(): number[];
    /** undefined when the environment cannot be read (gone, or another uid). */
    environ(pid: number): Record<string, string> | undefined;
    command(pid: number): string;
    parentOf(pid: number): number | undefined;
    /** The session id; a process whose session id is its own pid called setsid and is a daemon. */
    sessionOf(pid: number): number | undefined;
    isAlive(pid: number): boolean;
    signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
}
interface Target {
    pid: number;
    agentId: string;
    command: string;
}
interface ReapReport {
    agentIds: string[];
    count: number;
    commands: string[];
    survivors: number[];
}
type LaunchMatch = (env: Record<string, string>) => boolean;
declare const procTable: () => ProcessTable;
/** `run-agent <id>` is the launcher's own argv; a recycled pid runs something else. */
declare const isLauncherOf: (command: string, agentId: string) => boolean;
declare const isKnownDaemon: (command: string) => boolean;
/** Processes whose environment satisfies `match`, minus every one the safety rules protect. */
declare function findTargets(table: ProcessTable, match: LaunchMatch, self?: number): Target[];
/** Phase one: TERM. The targets go to `finishReap` once the grace has passed. */
declare function startReap(table: ProcessTable, match: LaunchMatch, self?: number): Target[];
/** Phase two: KILL what ignored TERM, and name whatever outlived even that. */
declare function finishReap(table: ProcessTable, targets: Target[]): number[];
declare function reportOf(targets: Target[], survivors: number[]): ReapReport;
/** The processes of one exact launch. */
declare const matchLaunch: (agentId: string, launcherPid: string) => LaunchMatch;
/**
 * The sweep's match: any launch of an agent whose row is finished, unless the launcher that
 * launch names is still a live `run-agent <id>`, which is a resume running under the same id.
 */
declare const matchFinished: (finished: ReadonlySet<string>, table: ProcessTable) => LaunchMatch;
/** Rows exited or retired for longer than the grace. */
declare function finishedIds(roster: readonly LaunchRow[], now: number): Set<string>;
interface ExitReapDeps {
    table: ProcessTable;
    log: (event: string, detail: Record<string, unknown>) => void;
    /** Synchronous: a `process.on('exit')` handler cannot await. */
    sleepSync: (ms: number) => void;
    platform: NodeJS.Platform;
    /** False logs `orphans_would_reap` and signals nothing. */
    kill: boolean;
}
declare const realExitDeps: (log: ExitReapDeps["log"], kill: boolean) => ExitReapDeps;
/** Run by `run-agent` as it exits: kills what its own launch left behind, then logs it. */
declare function reapOwnLaunch(agentId: string, launcherPid: number, deps: ExitReapDeps): ReapReport | undefined;

/**
 * CC-901: each agent on Linux gets its own TMPDIR, `/tmp/ac-<name>-<launcher pid>`, removed once
 * the launch's processes are gone.
 *
 * Without it every Linux agent shares /tmp, a 1M-inode tmpfs, and nothing an agent or its tools
 * leave there is ever removed. macOS keeps CC-500's per-user temp dir.
 *
 * The removal deletes files, so it is narrow on purpose: it only removes the exact path rebuilt
 * from a validated name and pid, never a pattern; it refuses a symlink, a non-directory and a
 * dir another user owns; and it keeps the dir while any process of that launch is alive or any
 * live process has its cwd or an open fd inside.
 *
 * CC-1184: a launch may put its dir under an on-disk root, `<home>/.cache/agent-chat/tmp`, instead
 * of /tmp, so a review's installed checkouts stop filling the tmpfs's inodes. CC-1264 made it the
 * default for every Linux launch; /tmp stays an accepted root for launches made before that and
 * for the sweep.
 *
 * CC-1266: Claude Code writes each Bash call's output under `CLAUDE_CODE_TMPDIR`, falling back to
 * TMPDIR. A launch's harness dir lives under its own root, `<home>/.cache/agent-chat/harness`, so
 * a full scratch dir cannot take the agent's Bash tool, and the `rm` to recover, down with it.
 *
 * Those three are the only roots accepted; every check above applies under each.
 */
declare const TMP_ROOT = "/tmp";
declare const DISK_TMP_ROOT_SUFFIX = "/.cache/agent-chat/tmp";
declare const HARNESS_ROOT_SUFFIX = "/.cache/agent-chat/harness";
interface TmpStat {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    uid: number;
}
interface TmpFs {
    /** undefined when the path does not exist. Never follows a symlink. */
    lstat(path: string): TmpStat | undefined;
    readdir(path: string): string[];
    /** `recursive` creates missing parents, as for the on-disk root; it does not fail when the path exists. */
    mkdir(path: string, mode: number, recursive?: boolean): void;
    chmod(path: string, mode: number): void;
    rm(path: string): void;
}
interface TmpProcessTable extends Pick<ProcessTable, "pids" | "environ" | "command" | "parentOf" | "isAlive"> {
    /** undefined when it cannot be read. */
    cwd(pid: number): string | undefined;
    /** Link targets of the process's open fds; empty when they cannot be read. */
    fds(pid: number): string[];
}
declare const realTmpFs: TmpFs;
declare const realTmpProcessTable: () => TmpProcessTable;
/** The on-disk root under `home`. */
declare const diskTmpRoot: (home: string) => string;
/** The on-disk root of the launches' Claude Code harness dirs under `home`. */
declare const diskHarnessRoot: (home: string) => string;
/** Every root a sweep scans for launches made under `home`, old /tmp launches included. */
declare const agentTmpSweepRoots: (home: string) => string[];
/** /tmp, or an absolute, normalised `<home>/.cache/agent-chat/tmp` or `<home>/.cache/agent-chat/harness`. */
declare const isTmpRoot: (root: string) => boolean;
/** The one path this module will ever create or remove for an agent, or undefined when any part is invalid. */
declare function agentTmpPath(name: string, pid: number, root?: string): string | undefined;
interface AgentTmpRequest {
    name: string;
    /** The launcher's pid: `run-agent`'s own, which a relaunch never reuses while the old one runs. */
    pid: number;
    /** Where the dir goes; defaults to /tmp. */
    root?: string;
    platform?: NodeJS.Platform;
    fs?: TmpFs;
    uid?: number;
}
/** Creates the agent's dir 0700 and returns it; undefined off Linux or when it cannot be made safely. */
declare function ensureAgentTmpDir(request: AgentTmpRequest): string | undefined;
type TmpRemoval = {
    removed: true;
    path: string;
    inodes: number;
} | {
    removed: false;
    path: string;
    reason: string;
    code?: string;
};
interface RemovalTarget {
    name: string;
    pid: number;
    /** The agent ids that may have launched under this name; a process of any of them keeps the dir. */
    agentIds: ReadonlySet<string>;
    /** Defaults to /tmp. */
    root?: string;
}
interface RemovalDeps {
    fs: TmpFs;
    table: TmpProcessTable;
    uid: number;
    /** The caller's pid: it and its ancestors never count as holding the dir. */
    self: number;
}
/**
 * Removes exactly `<root>/ac-<name>-<pid>` once nothing alive is tied to it. A missing dir or root is
 * not an error. A disk root that is a symlink, not a directory or another user's is refused, so the
 * recursive rm never resolves through it to an `ac-*` dir elsewhere.
 */
declare function removeAgentTmpDir(target: RemovalTarget, deps: RemovalDeps): TmpRemoval;

/** CC-901: removing a launch's TMPDIR, at its own exit and in the broker's periodic sweep of finished launches. */
type Log = (event: string, detail: Record<string, unknown>) => void;
interface ExitTmpDeps extends RemovalDeps {
    platform: NodeJS.Platform;
    log: Log;
}
declare const realExitTmpDeps: (log: Log) => ExitTmpDeps;
/** Run by `run-agent` as it exits, after the orphan reap: removes its own launch's dir under `root`. */
declare function removeOwnTmpDir(name: string, agentId: string, launcherPid: number, deps: ExitTmpDeps, root?: string): void;
interface TmpSweepDeps extends RemovalDeps {
    roster: () => readonly LaunchRow[];
    now: () => number;
    log: Log;
    /** Paths already reported as kept, so a standing refusal is logged once rather than every sweep. */
    announced?: Set<string>;
    /** The roots to scan; defaults to /tmp alone. A root that does not exist is skipped. */
    roots?: readonly string[];
}
/**
 * CC-1447: each /proc entry read at most once per sweep pass. `holder` scans every process for
 * every kept dir, so with ~770 dirs and ~2,400 processes an unshared table re-read /proc for
 * minutes, synchronously, and the broker stopped answering frames.
 */
declare function passSnapshot(table: TmpProcessTable): TmpProcessTable;
/** One pass: removes the dirs of agents whose rows are finished, for launches that left one behind. */
declare function sweepAgentTmpDirs(deps: TmpSweepDeps): void;

export { AGENT_ID_ENV, AGENT_NAME_PATTERN, ANTI_NESTING_VARS, type AgentFailure, type AgentFailureKind, type AgentInit, type AgentRunConfig, type AgentRunDeps, type AgentRunHarness, type AgentRunResult, type AgentTmpRequest, type AgentUsage, type AuthEnvCheckOptions, AuthMisconfiguredError, type BoundedRunBase, CLAUDE_CODE_PASSTHROUGH_VARS, CLAUDE_PRINT_KILL_GRACE_MS, CLAUDE_PRINT_UNSUPPORTED_OPTIONS, CODEX_APPROVAL_POLICIES, CODEX_RUNTIME_CAPABILITIES, CODEX_SANDBOXES, type ClassifyOptions, type ClaudeCodeAdapterOptions, type ClaudeCodeNativeOptions, type ClaudeCodeRunRequest, type CodexAppServer, type CodexAppServerEvent, CodexAppServerExitedError, type CodexAppServerOptions, CodexAppServerRpcError, type CodexApprovalPolicy, type CodexAvailability, type CodexAvailabilityDeps, type CodexAvailabilityOptions, type CodexCapabilityInspectionOptions, type CodexExecAdapterOptions, type CodexExecDeps, type CodexInitializeResult, type CodexNativeOptions, type CodexOutputSchema, type CodexProcessExit, type CodexProcessInput, type CodexRunRequest, type CodexRuntimeCapability, type CodexRuntimeInspection, type CodexSandbox, type CodexSchemaFile, CodexSteerPreconditionError, type CodexThreadOptions, type CodexThreadResult, type CodexThreadStatus, type CodexTurnStartParams, type CodexTurnStatus, type CodexTurnSteerParams, type CodexUserInput, type CodexVersionInspectionOptions, DEFAULT_CODEX_EXECUTABLE, DEFAULT_CODEX_KILL_GRACE_MS, DEFAULT_INACTIVITY_MS, DEFAULT_MAX_RETRIES, DISK_TMP_ROOT_SUFFIX, type DurableCancelResult, type DurableDispatchAck, type DurableDispatchInput, type DurableHarnessDispatcher, type DurableHarnessDispatcherDeps, type DurableHarnessDispatcherOptions, type DurableHarnessRecord, type DurableHarnessSuccess, type DurableLiveHandle, type DurableReconcileOutcome, type DurableSettlement, type ExitReapDeps, type ExitTmpDeps, FORBIDDEN_API_KEY_SOURCES, HARNESS_ROOT_SUFFIX, type Harness, type HarnessAdapter, type HarnessCapabilityDescriptor, type HarnessRunProgress, type HarnessRunRequest, type HarnessRunRequestFor, type HarnessRunResult, KILL_GRACE_MS, LAUNCHER_PID_ENV, LAUNCH_IDENTITY_ENV, type LaunchMatch, type LaunchRow, MIN_CODEX_EXEC_VERSION, type PrepareEnvOptions, type ProcessTable, RESTART_GAP_ENV, RESTART_TOKEN_ENV, type ReapReport, type RemovalDeps, type RemovalTarget, STRIPPED_AUTH_VARS, STRIPPED_CODEX_AUTH_VARS, STRIPPED_PROXY_VARS, SUPPORTED_CODEX_EXEC_VERSION, SWEEP_GRACE_MS, type SupervisedCodexProcess, TMP_ROOT, type Target, type TmpFs, type TmpProcessTable, type TmpRemoval, type TmpStat, type TmpSweepDeps, agentTmpPath, agentTmpSweepRoots, assertApiKeySourceAllowed, assertAuthEnvOk, buildClaudePrintArgs, buildCodexExecArgs, checkCodexAvailable, classifyResult, claudeCodeCapabilities, claudePrintCapabilities, clearLaunchIdentity, clearLaunchTmpDirs, codexExecCapabilities, createClaudeCodeAdapter, createCodexExecAdapter, createDurableHarnessDispatcher, diskHarnessRoot, diskTmpRoot, dispatchHarnessRun, ensureAgentTmpDir, findTargets, finishReap, finishedIds, inspectCodexCapabilities, isKnownDaemon, isLaunchTmpDir, isLauncherOf, isTmpRoot, matchFinished, matchLaunch, passSnapshot, preflightHarnessRun, prepareCodexEnv, prepareEnv, procTable, realExitDeps, realExitTmpDeps, realTmpFs, realTmpProcessTable, reapOwnLaunch, removeAgentTmpDir, removeOwnTmpDir, reportOf, resolveClaudeBin, runAgent, startCodexAppServer, startReap, sumModelCost, sweepAgentTmpDirs, usageFromResult, withoutLaunchIdentity };
