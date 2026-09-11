import { randomUUID } from "node:crypto";
import { query, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ConversationIdentity, ExecutionIdentity } from "@titan-design/agent-protocol";
import { EXECUTION_CAPABILITIES, type ClaudeCodeRunRequest, type HarnessAdapter, type HarnessCapabilityDescriptor, type HarnessRunFailure, type HarnessRunProgress, type HarnessRunResult } from "./harness-contracts.js";
import { preflightHarnessRun } from "./preflight.js";
import { runAgent, type AgentRunDeps } from "./run.js";
import { claudeFailure, claudeUsage } from "./claude-code-result.js";

export interface ClaudeCodeAdapterOptions {
  maxTurns: number;
  maxBudgetUsd: number;
  inactivityTimeoutMs?: number;
  deps?: AgentRunDeps;
}

/** Existing Claude query circuit breakers remain mandatory; their native units stay explicit. */
export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions): HarnessAdapter<"claude-code"> {
  for (const field of ["maxTurns", "maxBudgetUsd", "inactivityTimeoutMs"] as const) {
    const value = options[field];
    if (value === undefined && field === "inactivityTimeoutMs") continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new TypeError(`${field} must be positive and finite`);
  }
  const descriptor = claudeCodeCapabilities();
  return {
    descriptor,
    async run<T>(request: ClaudeCodeRunRequest<T>): Promise<HarnessRunResult<T, "claude-code">> {
      const failure = preflightHarnessRun(request, descriptor);
      if (failure) return { ok: false, harness: "claude-code", failure, usage: [] };
      if (request.wallTimeMs > 2_147_483_647) return { ok: false, harness: "claude-code", failure: { kind: "invalid_request", reason: "wallTimeMs exceeds the local timer range" }, usage: [] };
      return new ClaudeInvocation(request, options).run();
    },
  };
}

export function claudeCodeCapabilities(): HarnessCapabilityDescriptor<"claude-code"> {
  const capabilities = Object.fromEntries(EXECUTION_CAPABILITIES.map(capability => [capability, {
    status: "unsupported", reason: "not exposed by this bounded Claude SDK adapter",
  }])) as HarnessCapabilityDescriptor<"claude-code">["capabilities"];
  for (const capability of ["fresh_run", "resume", "structured_output", "external_cancellation", "token_reporting"] as const) {
    capabilities[capability] = { status: "supported", evidence: "bounded wrapper around the existing runAgent SDK query" };
  }
  return {
    harness: "claude-code", adapter: { name: "claude-sdk-bounded", version: "1" }, capabilities,
    limits: [{ unit: "milliseconds", scope: "execution", enforcement: "hard", assessment: {
      status: "supported", evidence: "local deadline aborts and closes the owned query; native cancellation remains unconfirmed",
    } }],
  };
}

type ProgressBody<T> = T extends unknown ? Omit<T, "harness" | "atMs"> : never;

class ClaudeInvocation<T> {
  private readonly controller = new AbortController();
  private readonly execution: ExecutionIdentity;
  private conversation?: ConversationIdentity;
  private stream?: Query;
  private active = true;
  private timer?: ReturnType<typeof setTimeout>;
  private stop!: (failure: HarnessRunFailure) => void;
  private readonly onAbort = () => this.stop({ kind: "aborted", reason: String(this.request.signal?.reason ?? "caller aborted") });

  constructor(private readonly request: ClaudeCodeRunRequest<T>, private readonly options: ClaudeCodeAdapterOptions) {
    this.conversation = request.target.kind === "resume" ? request.target.conversation : undefined;
    this.execution = { executionId: randomUUID(), ...(this.conversation ? { conversation: this.conversation } : {}) };
  }

  async run(): Promise<HarnessRunResult<T, "claude-code">> {
    try {
      const stopped = new Promise<HarnessRunResult<T, "claude-code">>(resolve => {
        this.stop = failure => {
          if (!this.active) return;
          this.active = false;
          this.controller.abort(new Error(failure.reason));
          this.close();
          resolve(this.failed(failure));
        };
      });
      this.timer = setTimeout(() => this.stop({ kind: "wall_time_exceeded", reason: "Claude query exceeded local wall deadline", wallTimeMs: this.request.wallTimeMs }), this.request.wallTimeMs);
      this.timer.unref?.();
      this.request.signal?.addEventListener("abort", this.onAbort, { once: true });
      if (this.request.signal?.aborted) this.onAbort();
      this.emit({ kind: "execution_started", execution: this.execution });
      if (!this.active) return await stopped;
      const result = await Promise.race([this.invoke(), stopped]);
      this.active = false;
      this.emit({ kind: "execution_finished", executionId: this.execution.executionId,
        outcome: result.ok ? "succeeded" : result.failure.kind === "aborted" || result.failure.kind === "wall_time_exceeded" || result.failure.kind === "cancelled_unknown" ? "cancelled" : "failed" });
      return result;
    } catch (error) {
      this.controller.abort(error);
      return this.failed({ kind: "runtime_error", reason: error instanceof Error ? error.message : String(error) });
    } finally {
      this.active = false;
      if (this.timer) clearTimeout(this.timer);
      this.request.signal?.removeEventListener("abort", this.onAbort);
      this.close();
    }
  }

  private async invoke(): Promise<HarnessRunResult<T, "claude-code">> {
    const result = await runAgent<T>({
      ...this.request.native, prompt: this.request.prompt, cwd: this.request.cwd,
      maxTurns: this.options.maxTurns, maxBudgetUsd: this.options.maxBudgetUsd,
      inactivityTimeoutMs: this.options.inactivityTimeoutMs, signal: this.controller.signal,
      resumeSessionId: this.request.target.kind === "resume" ? this.request.target.conversation.nativeId : undefined,
      onMessage: message => this.observe(message),
    }, { ...this.options.deps, query: args => {
      this.stream = (this.options.deps?.query ?? query)(args);
      return this.stream;
    } });
    if (!this.active) return this.failed({ kind: "cancelled_unknown", reason: "query completed after local supervision ended" });
    if (result.sessionId) this.identify(result.sessionId);
    const usage = claudeUsage(result.usage, this.execution.executionId);
    if (!result.ok) return { ...this.failed(claudeFailure(result.failure)), usage };
    if (!this.conversation) return this.failed({ kind: "runtime_error", reason: "Claude query returned no conversation identity" });
    return {
      ok: true, harness: "claude-code", execution: { ...this.execution, conversation: this.conversation }, conversation: this.conversation,
      output: this.request.native?.outputSchema ? { kind: "structured", value: result.output } : { kind: "text", text: String(result.output) }, usage,
    };
  }

  private observe(message: SDKMessage): void {
    if (!this.active) return;
    if ("session_id" in message && typeof message.session_id === "string") this.identify(message.session_id);
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") this.emit({ kind: "assistant_output", executionId: this.execution.executionId, text: block.text });
      }
    }
  }

  private identify(nativeId: string): void {
    if (this.conversation) {
      if (this.conversation.nativeId !== nativeId) throw new Error("Claude query changed conversation identity");
      return;
    }
    this.conversation = { harness: "claude-code", namespace: this.request.target.kind === "fresh" ? this.request.target.namespace : this.request.target.conversation.namespace, nativeId };
    this.emit({ kind: "conversation_identified", executionId: this.execution.executionId, conversation: this.conversation });
  }

  private failed(failure: HarnessRunFailure): HarnessRunResult<T, "claude-code"> {
    return { ok: false, harness: "claude-code", execution: this.execution,
      ...(this.conversation ? { conversation: this.conversation } : {}), failure, usage: [] };
  }

  private emit(progress: ProgressBody<HarnessRunProgress>): void {
    this.request.onProgress?.({ ...progress, harness: "claude-code", atMs: (this.options.deps?.now ?? Date.now)() } as HarnessRunProgress);
  }

  private close(): void {
    try { this.stream?.close(); } catch { /* A failed close does not prove native cancellation. */ }
  }
}
