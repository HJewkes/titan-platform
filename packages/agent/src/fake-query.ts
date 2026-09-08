import type { ModelUsage, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunDeps } from "./run.js";

/**
 * Hand-built SDK message sequences so the run loop is testable without a
 * subprocess, a network call, or a credential. Internal to the package's own
 * tests; deliberately not re-exported from `index.ts`.
 */

export const SESSION_ID = "sess-1";

export function initMessage(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    model: "claude-opus-5",
    tools: ["Read", "Bash"],
    permissionMode: "dontAsk",
    claude_code_version: "2.1.300",
    cwd: "/tmp/work",
    mcp_servers: [],
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: "uuid-init",
    session_id: SESSION_ID,
    ...overrides,
  } as unknown as SDKMessage;
}

export function assistantMessage(text: string): SDKMessage {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    uuid: `uuid-${text.slice(0, 8)}`,
    session_id: SESSION_ID,
  } as unknown as SDKMessage;
}

export function rateLimitEvent(resetsAt: number): SDKMessage {
  return {
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour" },
    uuid: "uuid-rate-limit",
    session_id: SESSION_ID,
  } as unknown as SDKMessage;
}

export function modelUsage(costUSD: number): ModelUsage {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  };
}

export function successResult(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1200,
    duration_api_ms: 900,
    is_error: false,
    num_turns: 3,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: 0.25,
    usage: {},
    modelUsage: { "claude-opus-5": modelUsage(0.25) },
    permission_denials: [],
    uuid: "uuid-result",
    session_id: SESSION_ID,
    ...overrides,
  } as unknown as SDKMessage;
}

export function errorResult(subtype: string, errors: string[] = []): SDKMessage {
  return {
    type: "result",
    subtype,
    duration_ms: 800,
    duration_api_ms: 500,
    is_error: true,
    num_turns: 2,
    stop_reason: null,
    total_cost_usd: 0.1,
    usage: {},
    modelUsage: { "claude-opus-5": modelUsage(0.1) },
    permission_denials: [],
    errors,
    uuid: "uuid-result",
    session_id: SESSION_ID,
  } as unknown as SDKMessage;
}

export interface FakeQueryOptions {
  /** Called after each message is yielded, so a test can abort mid-stream. */
  afterYield?: (index: number) => void;
  /** Stall after the last message until the run's own abort fires, like a wedged CLI. */
  hangAtEnd?: boolean;
  /** Blow up after the last message, like a CLI subprocess that died. */
  throwAtEnd?: Error;
}

export interface FakeQuery {
  run: NonNullable<AgentRunDeps["query"]>;
  /** Messages actually pulled from the generator, so a test can prove the run stopped early. */
  yielded: SDKMessage[];
  closed: boolean;
  lastOptions: Record<string, unknown> | undefined;
}

export function fakeQuery(messages: SDKMessage[], options: FakeQueryOptions = {}): FakeQuery {
  const state: FakeQuery = { run: null as never, yielded: [], closed: false, lastOptions: undefined };

  state.run = ((params: { prompt: string | AsyncIterable<unknown>; options?: Record<string, unknown> }) => {
    state.lastOptions = params.options;
    const signal = (params.options?.abortController as AbortController | undefined)?.signal;

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      for (const [index, message] of messages.entries()) {
        if (signal?.aborted) return;
        state.yielded.push(message);
        yield message;
        options.afterYield?.(index);
      }
      if (options.hangAtEnd) await untilAborted(signal);
      if (options.throwAtEnd) throw options.throwAtEnd;
    }

    const generator = generate() as Query;
    generator.close = () => {
      state.closed = true;
    };
    return generator;
  }) as NonNullable<AgentRunDeps["query"]>;

  return state;
}

function untilAborted(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
