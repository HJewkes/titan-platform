import { conversationItemRef } from "@titan-design/agent-protocol";
import type { ConversationIdentity, ExecutionIdentity, TokenCounts, UsageMeasurement } from "@titan-design/agent-protocol";
import type { CodexProcessExit, SupervisedCodexProcess } from "./codex-process.js";
import type { CodexRunRequest, HarnessRunFailure, HarnessRunProgress, HarnessRunResult } from "./harness-contracts.js";

export const DEFAULT_CODEX_KILL_GRACE_MS = 2_000;

export async function runCodexExecSession<T>(
  request: CodexRunRequest<T>,
  processHandle: SupervisedCodexProcess,
  executionId: string,
  now: () => number,
  killGraceMs = DEFAULT_CODEX_KILL_GRACE_MS,
  processWallTimeMs = request.wallTimeMs,
  cleanup?: () => Promise<void>,
): Promise<HarnessRunResult<T, "codex">> {
  return new CodexExecSession(request, processHandle, executionId, now, killGraceMs, processWallTimeMs, cleanup).run();
}

class CodexExecSession<T> {
  private conversation: ConversationIdentity | undefined;
  private finalText: string | undefined;
  private usageRaw: unknown;
  private nativeTurnId: string | undefined;
  private turnCompleted = false;
  private nativeTerminalObserved = false;
  private streamError: HarnessRunFailure | undefined;
  private stderr = "";
  private stopReason: "abort" | "timeout" | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private forceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onAbort = () => this.stop("abort");

  constructor(
    private readonly request: CodexRunRequest<T>,
    private readonly processHandle: SupervisedCodexProcess,
    private readonly executionId: string,
    private readonly now: () => number,
    private readonly killGraceMs: number,
    private readonly processWallTimeMs: number,
    private readonly cleanup: (() => Promise<void>) | undefined,
  ) {}

  async run(): Promise<HarnessRunResult<T, "codex">> {
    try {
      this.request.signal?.addEventListener("abort", this.onAbort);
      this.timer = setTimeout(() => this.stop("timeout"), this.processWallTimeMs);
      this.timer.unref?.();
      this.emit({ kind: "execution_started", execution: { executionId: this.executionId } });
      const [, , exit] = await Promise.all([this.readStdout(), this.readStderr(), this.processHandle.completed]);
      let result = this.settle(exit);
      result = await this.finishCleanup(result);
      return this.finish(result);
    } catch (error) {
      this.terminate();
      await this.ignoreExitFailure();
      let result = this.failure({ kind: "runtime_error", reason: messageOf(error), native: error });
      result = await this.finishCleanup(result);
      return this.finish(result);
    } finally {
      this.dispose();
    }
  }

  private async readStdout(): Promise<void> {
    for await (const line of this.processHandle.stdout) {
      if (!line.trim()) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        this.streamError = { kind: "runtime_error", reason: "Codex emitted malformed JSONL", native: { line } };
        this.terminate();
        return;
      }
      this.absorb(event);
    }
  }

  private async readStderr(): Promise<void> {
    for await (const line of this.processHandle.stderr) this.stderr = `${this.stderr}${line}\n`.slice(-65_536);
  }

  private absorb(value: unknown): void {
    if (!record(value) || typeof value.type !== "string") return;
    if (value.type === "thread.started" && typeof value.thread_id === "string") this.identify(value.thread_id);
    if (value.type === "turn.started") this.nativeTurnId = turnId(value) ?? this.nativeTurnId;
    if (isAgentMessage(value)) {
      this.finalText = value.item.text;
      this.emit({ kind: "assistant_output", executionId: this.executionId, text: value.item.text });
    }
    if (value.type === "turn.completed") {
      this.turnCompleted = true;
      this.nativeTerminalObserved = true;
      this.nativeTurnId = turnId(value) ?? this.nativeTurnId;
      this.usageRaw = value.usage;
    }
    if (value.type === "turn.failed") this.nativeTerminalObserved = true;
    if (value.type === "turn.failed" || value.type === "error") {
      this.streamError = { kind: "runtime_error", reason: eventMessage(value), native: value };
    }
  }

  private identify(nativeId: string): void {
    if (!nativeId.trim()) return this.failStream("Codex emitted an empty native thread ID");
    if (this.request.target.kind === "resume" && nativeId !== this.request.target.conversation.nativeId) {
      return this.failStream("Codex resumed a different native conversation");
    }
    const namespace =
      this.request.target.kind === "fresh" ? this.request.target.namespace : this.request.target.conversation.namespace;
    this.conversation = { harness: "codex", namespace, nativeId };
    this.emit({ kind: "conversation_identified", executionId: this.executionId, conversation: this.conversation });
  }

  private failStream(reason: string): void {
    this.streamError = { kind: "runtime_error", reason };
    this.terminate();
  }

  private settle(exit: CodexProcessExit): HarnessRunResult<T, "codex"> {
    if (this.stopReason && !this.nativeTerminalObserved) return this.failure(cancelledUnknown(this.stopReason, this.request, exit));
    if (this.stopReason === "timeout") return this.failure(timeoutFailure(this.request.wallTimeMs));
    if (this.stopReason === "abort") return this.failure(abortFailure(this.request.signal));
    if (this.streamError) return this.failure(this.streamError);
    if (exit.exitCode !== 0) return this.failure(exitFailure(exit, this.stderr));
    return this.success();
  }

  private success(): HarnessRunResult<T, "codex"> {
    if (!this.conversation) return this.failure({ kind: "runtime_error", reason: "Codex completed without a thread.started event" });
    if (!this.turnCompleted) return this.failure({ kind: "runtime_error", reason: "Codex completed without a turn.completed event" });
    if (this.finalText === undefined) return this.failure({ kind: "runtime_error", reason: "Codex completed without a final agent message" });
    const output = parseOutput(this.request, this.finalText);
    if ("failure" in output) return this.failure(output.failure);
    return {
      ok: true,
      harness: "codex",
      execution: { executionId: this.executionId, conversation: this.conversation },
      conversation: this.conversation,
      output: output.output,
      usage: this.usage(),
      transcript: { format: "codex-rollout-jsonl", namespace: this.conversation.namespace },
    };
  }

  private usage(): readonly UsageMeasurement[] {
    if (!this.conversation || !record(this.usageRaw)) return [];
    const measurement: UsageMeasurement = {
      kind: "snapshot",
      scope: "turn",
      scopeId: this.turnScopeId(),
      epoch: this.executionId,
      sequence: 0,
      model: this.request.native?.model ?? null,
      tokens: tokenCounts(this.usageRaw),
      cost: null,
      source: "codex-exec.turn.completed.usage",
    };
    return [measurement];
  }

  private turnScopeId(): string {
    if (this.conversation && this.nativeTurnId) return conversationItemRef(this.conversation, "turn", this.nativeTurnId);
    // Codex exec does not currently report a turn ID. Keep the snapshot scoped to
    // this invocation rather than mislabeling it as a conversation total.
    return `execution:${encodeURIComponent(this.executionId)}:turn`;
  }

  private failure(failure: HarnessRunFailure): HarnessRunResult<T, "codex"> {
    const execution: ExecutionIdentity = {
      executionId: this.executionId,
      ...(this.conversation ? { conversation: this.conversation } : {}),
    };
    const result: HarnessRunResult<T, "codex"> = {
      ok: false,
      harness: "codex",
      execution,
      failure,
      usage: this.usage(),
    };
    if (this.conversation) result.conversation = this.conversation;
    return result;
  }

  private stop(reason: "abort" | "timeout"): void {
    if (this.stopReason) return;
    this.stopReason = reason;
    this.terminate();
  }

  private terminate(): void {
    this.processHandle.terminate("SIGTERM");
    if (this.forceTimer) return;
    this.forceTimer = setTimeout(() => this.processHandle.terminate("SIGKILL"), this.killGraceMs);
    this.forceTimer.unref?.();
  }

  private async ignoreExitFailure(): Promise<void> {
    try {
      await this.processHandle.completed;
    } catch {
      // The original process/stream error is the useful failure.
    }
  }

  private finish(result: HarnessRunResult<T, "codex">): HarnessRunResult<T, "codex"> {
    for (const measurement of result.usage) {
      this.emit({ kind: "usage", executionId: this.executionId, measurement });
    }
    if (this.streamError && result.ok) result = this.failure(this.streamError);
    const cancelled = !result.ok && (result.failure.kind === "aborted" || result.failure.kind === "cancelled_unknown");
    const outcome = result.ok ? "succeeded" : cancelled ? "cancelled" : "failed";
    this.emit({ kind: "execution_finished", executionId: this.executionId, outcome });
    return this.streamError && result.ok ? this.failure(this.streamError) : result;
  }

  private emit(progress: ProgressPayload): void {
    if (!this.request.onProgress || this.streamError) return;
    try {
      this.request.onProgress({ ...progress, harness: "codex", atMs: this.now() } as HarnessRunProgress);
    } catch (error) {
      this.streamError = { kind: "runtime_error", reason: `Codex progress callback failed: ${messageOf(error)}`, native: error };
      this.terminate();
    }
  }

  private async finishCleanup(result: HarnessRunResult<T, "codex">): Promise<HarnessRunResult<T, "codex">> {
    if (!this.cleanup) return result;
    try {
      await this.cleanup();
      return result;
    } catch (error) {
      return this.failure({ kind: "runtime_error", reason: messageOf(error), native: error });
    }
  }

  private dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.forceTimer) clearTimeout(this.forceTimer);
    this.request.signal?.removeEventListener("abort", this.onAbort);
  }
}

type ParsedOutput<T> =
  | { output: { kind: "text"; text: string } | { kind: "structured"; value: T } }
  | { failure: HarnessRunFailure };

function parseOutput<T>(request: CodexRunRequest<T>, text: string): ParsedOutput<T> {
  const schema = request.native?.outputSchema;
  if (!schema) return { output: { kind: "text", text } };
  try {
    return { output: { kind: "structured", value: schema.parse(JSON.parse(text)) } };
  } catch (error) {
    const reason = `structured output validation failed: ${messageOf(error)}`;
    return { failure: { kind: "output_invalid", reason, native: { text, error } } };
  }
}

type ProgressPayload =
  | { kind: "execution_started"; execution: ExecutionIdentity }
  | { kind: "conversation_identified"; executionId: string; conversation: ConversationIdentity }
  | { kind: "assistant_output"; executionId: string; text: string }
  | { kind: "usage"; executionId: string; measurement: UsageMeasurement }
  | { kind: "execution_finished"; executionId: string; outcome: "succeeded" | "failed" | "cancelled" };

function tokenCounts(usage: Record<string, unknown>): TokenCounts {
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  return {
    input,
    output,
    cachedInput: count(usage.cached_input_tokens),
    cacheWriteInput: null,
    reasoningOutput: count(usage.reasoning_output_tokens),
    total: input === null || output === null ? null : input + output,
  };
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isAgentMessage(event: Record<string, unknown>): event is Record<string, unknown> & {
  item: { type: "agent_message"; text: string };
} {
  return event.type === "item.completed" && record(event.item) && event.item.type === "agent_message" && typeof event.item.text === "string";
}

function turnId(event: Record<string, unknown>): string | undefined {
  if (typeof event.turn_id === "string" && event.turn_id.trim()) return event.turn_id;
  if (record(event.turn) && typeof event.turn.id === "string" && event.turn.id.trim()) return event.turn.id;
  return undefined;
}

function timeoutFailure(wallTimeMs: number): HarnessRunFailure {
  return { kind: "wall_time_exceeded", reason: "Codex execution exceeded its wall deadline", wallTimeMs };
}

function abortFailure(signal: AbortSignal | undefined): HarnessRunFailure {
  return { kind: "aborted", reason: String(signal?.reason ?? "aborted by caller") };
}

function cancelledUnknown(
  cause: "abort" | "timeout",
  request: CodexRunRequest<unknown>,
  exit: CodexProcessExit,
): HarnessRunFailure {
  const requested = cause === "timeout"
    ? { kind: "wall_time_exceeded", wallTimeMs: request.wallTimeMs }
    : { kind: "external_abort", reason: String(request.signal?.reason ?? "aborted by caller") };
  return {
    kind: "cancelled_unknown",
    reason: `Codex process stopped after ${cause} without a native terminal turn event`,
    native: { cause, requested, processExit: exit },
  };
}

function exitFailure(exit: CodexProcessExit, stderr: string): HarnessRunFailure {
  return {
    kind: "runtime_error",
    reason: stderr.trim() || `Codex exited with status ${String(exit.exitCode)}`,
    native: exit,
  };
}

function eventMessage(event: Record<string, unknown>): string {
  if (typeof event.message === "string") return event.message;
  if (record(event.error) && typeof event.error.message === "string") return event.error.message;
  return `Codex emitted ${String(event.type)}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
