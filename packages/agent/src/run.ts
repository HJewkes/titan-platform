import { query, type Options, type Query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { toJSONSchema } from "zod";
import { AuthMisconfiguredError, assertApiKeySourceAllowed, assertAuthEnvOk, prepareEnv } from "./env.js";
import { classifyResult, usageFromResult } from "./failures.js";
import type { AgentFailure, AgentInit, AgentRunConfig, AgentRunResult } from "./types.js";

export const DEFAULT_INACTIVITY_MS = 600_000;

export interface AgentRunDeps {
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
export async function runAgent<T = string>(
  config: AgentRunConfig<T>,
  deps: AgentRunDeps = {},
): Promise<AgentRunResult<T>> {
  assertBudgets(config);
  const now = deps.now ?? Date.now;
  const startedAt = now();

  const env = prepareEnv(deps.env ?? process.env, { allowApiKeyBilling: config.allowApiKeyBilling });
  try {
    assertAuthEnvOk(env, { allowApiKeyBilling: config.allowApiKeyBilling });
  } catch (error) {
    return { ok: false, failure: authFailure(error) };
  }

  const session = new Session(config, env, deps);
  try {
    return await session.run(startedAt);
  } finally {
    session.dispose();
  }
}

/** The SDK leaves both circuit breakers unlimited, so a missing one is a bug, not a default. */
function assertBudgets(config: AgentRunConfig<unknown>): void {
  requirePositive("maxTurns", config.maxTurns);
  requirePositive("maxBudgetUsd", config.maxBudgetUsd);
}

function requirePositive(field: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${field} is required and must be a positive finite number (received ${String(value)})`);
  }
}

function authFailure(error: unknown): AgentFailure {
  const failure: AgentFailure = { kind: "auth_misconfigured", reason: messageOf(error) };
  if (error instanceof AuthMisconfiguredError && error.hint) failure.hint = error.hint;
  return failure;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type EndReason = { kind: "aborted"; reason: string } | { kind: "inactivity_timeout"; timeoutMs: number };

/** One `query()` call plus the watchdog, abort wiring and stream state it owns. */
class Session<T> {
  private readonly controller = new AbortController();
  private readonly inactivityMs: number;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private stream: Query | undefined;
  private endReason: EndReason | undefined;
  private init: AgentInit | undefined;
  private sessionId: string | undefined;
  private result: SDKResultMessage | undefined;
  private rateLimitResetsAt: number | undefined;
  private authError: AuthMisconfiguredError | undefined;
  private readonly onExternalAbort = () => {
    this.end({ kind: "aborted", reason: String(this.config.signal?.reason ?? "aborted by caller") });
  };

  constructor(
    private readonly config: AgentRunConfig<T>,
    private readonly env: Record<string, string>,
    private readonly deps: AgentRunDeps,
  ) {
    this.inactivityMs = config.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_MS;
  }

  async run(startedAt: number): Promise<AgentRunResult<T>> {
    const signal = this.config.signal;
    if (signal?.aborted) this.onExternalAbort();
    else signal?.addEventListener("abort", this.onExternalAbort);

    this.resetWatchdog();
    const run = this.deps.query ?? query;
    const elapsed = () => (this.deps.now ?? Date.now)() - startedAt;

    try {
      this.stream = run({ prompt: this.config.prompt, options: this.buildOptions() });
      for await (const message of this.stream) {
        this.resetWatchdog();
        this.config.onMessage?.(message);
        this.absorb(message);
        if (this.endReason || this.authError) break;
      }
    } catch (error) {
      if (!this.endReason) return this.fail({ kind: "runtime_error", reason: messageOf(error), raw: error }, elapsed());
    }
    return this.settle(elapsed());
  }

  dispose(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.config.signal?.removeEventListener("abort", this.onExternalAbort);
    // `close()` tears down the CLI subprocess; guarded because older SDKs lack it.
    if (typeof this.stream?.close === "function") this.stream.close();
  }

  private buildOptions(): Options {
    const c = this.config;
    const options: Options = {
      cwd: c.cwd,
      env: this.env,
      abortController: this.controller,
      maxTurns: c.maxTurns,
      maxBudgetUsd: c.maxBudgetUsd,
      permissionMode: c.permissionMode ?? "dontAsk",
      settingSources: c.settingSources ?? [],
    };
    if (c.model) options.model = c.model;
    if (c.allowedTools) options.allowedTools = c.allowedTools;
    if (c.disallowedTools) options.disallowedTools = c.disallowedTools;
    if (c.resumeSessionId) options.resume = c.resumeSessionId;
    if (c.agents) options.agents = c.agents;
    if (c.mcpServers) options.mcpServers = c.mcpServers;
    if (c.hooks) options.hooks = c.hooks;
    if (c.outputSchema) {
      options.outputFormat = { type: "json_schema", schema: toJSONSchema(c.outputSchema) as Record<string, unknown> };
    }
    return options;
  }

  private absorb(message: SDKMessage): void {
    if ("session_id" in message && typeof message.session_id === "string") this.sessionId = message.session_id;
    if (message.type === "system" && message.subtype === "init") {
      this.init = {
        apiKeySource: message.apiKeySource,
        model: message.model,
        tools: message.tools ?? [],
        permissionMode: message.permissionMode,
        claudeCodeVersion: message.claude_code_version,
      };
      if (!this.config.allowApiKeyBilling) this.checkApiKeySource(message.apiKeySource);
      return;
    }
    if (message.type === "rate_limit_event") this.rateLimitResetsAt = message.rate_limit_info.resetsAt;
    if (message.type === "result") this.result = message;
  }

  private checkApiKeySource(observed: string | undefined): void {
    try {
      assertApiKeySourceAllowed(observed);
    } catch (error) {
      // Stop the session here rather than let a mis-billed run continue spending.
      this.authError = error instanceof AuthMisconfiguredError ? error : new AuthMisconfiguredError(messageOf(error));
      this.controller.abort(this.authError);
    }
  }

  private end(reason: EndReason): void {
    this.endReason ??= reason;
    this.controller.abort(new Error(describeEnd(reason)));
  }

  private resetWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.end({ kind: "inactivity_timeout", timeoutMs: this.inactivityMs });
    }, this.inactivityMs);
    this.watchdog.unref?.();
  }

  private settle(durationMs: number): AgentRunResult<T> {
    if (this.authError) return this.fail(authFailure(this.authError), durationMs);
    if (this.endReason) return this.fail(endFailure(this.endReason), durationMs);
    if (!this.result) {
      const reason = "the session ended without emitting a result message";
      return this.fail({ kind: "runtime_error", reason }, durationMs);
    }

    const options: { now?: number; rateLimitResetsAt?: number } = {};
    if (this.deps.now) options.now = this.deps.now();
    if (this.rateLimitResetsAt !== undefined) options.rateLimitResetsAt = this.rateLimitResetsAt;
    const failure = classifyResult(this.result, options);
    if (failure) return this.fail(failure, durationMs);

    return this.succeed(this.result, durationMs);
  }

  private succeed(result: SDKResultMessage, durationMs: number): AgentRunResult<T> {
    const usage = usageFromResult(result, durationMs);
    if (!this.init || !this.sessionId) {
      const reason = "the session produced a result but never emitted an init message";
      return { ok: false, failure: { kind: "runtime_error", reason, raw: result }, usage };
    }
    const output = this.readOutput(result);
    if ("failure" in output) return { ok: false, failure: output.failure, sessionId: this.sessionId, usage };
    return { ok: true, output: output.value, sessionId: this.sessionId, usage, init: this.init };
  }

  /**
   * The SDK already validated `structured_output` against the same schema; we
   * re-parse so the value the caller receives is the one TypeScript promises.
   */
  private readOutput(result: SDKResultMessage): { value: T } | { failure: AgentFailure } {
    const schema = this.config.outputSchema;
    if (!schema) return { value: (result.subtype === "success" ? result.result : "") as T };
    const raw = result.subtype === "success" ? result.structured_output : undefined;
    const parsed = schema.safeParse(raw);
    if (parsed.success) return { value: parsed.data };
    return {
      failure: {
        kind: "schema_invalid",
        reason: "structured output did not match the supplied schema",
        error: parsed.error,
        raw,
      },
    };
  }

  private fail(failure: AgentFailure, durationMs: number): AgentRunResult<T> {
    const out: AgentRunResult<T> = { ok: false, failure };
    if (this.sessionId) out.sessionId = this.sessionId;
    if (this.result) out.usage = usageFromResult(this.result, durationMs);
    return out;
  }
}

function endFailure(reason: EndReason): AgentFailure {
  if (reason.kind === "aborted") return { kind: "aborted", reason: reason.reason };
  return { kind: "inactivity_timeout", reason: describeEnd(reason), timeoutMs: reason.timeoutMs };
}

function describeEnd(reason: EndReason): string {
  return reason.kind === "aborted" ? reason.reason : `no message for ${reason.timeoutMs}ms`;
}
