import type { ModelUsage, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { partialFake } from "@titan-design/test-kit";
import type { AgentRunDeps } from "./run.js";

type InitMessage = Extract<SDKMessage, { type: "system"; subtype: "init" }>;
type AssistantMessage = Extract<SDKMessage, { type: "assistant" }>;
type RateLimitMessage = Extract<SDKMessage, { type: "rate_limit_event" }>;
export type SuccessMessage = Extract<SDKMessage, { type: "result"; subtype: "success" }>;
type ErrorMessage = Exclude<Extract<SDKMessage, { type: "result" }>, SuccessMessage>;

/**
 * Hand-built SDK message sequences so the run loop is testable without a
 * subprocess, a network call, or a credential. Internal to the package's own
 * tests; deliberately not re-exported from `index.ts`.
 */

export const SESSION_ID = "sess-1";

export function initMessage(overrides: Partial<InitMessage> = {}): InitMessage {
  return partialFake<InitMessage>({
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
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: SESSION_ID,
    ...overrides,
  });
}

export function assistantMessage(text: string): SDKMessage {
  return partialFake<AssistantMessage>({
    type: "assistant",
    message: partialFake<AssistantMessage["message"]>({ role: "assistant", content: [partialFake<AssistantMessage["message"]["content"][number]>({ type: "text", text })] }),
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000002",
    session_id: SESSION_ID,
  });
}

export function rateLimitEvent(resetsAt: number): SDKMessage {
  return partialFake<RateLimitMessage>({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour" },
    uuid: "00000000-0000-4000-8000-000000000003",
    session_id: SESSION_ID,
  });
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

export function successResult(overrides: Partial<SuccessMessage> = {}): SuccessMessage {
  return partialFake<SuccessMessage>({
    type: "result",
    subtype: "success",
    duration_ms: 1200,
    duration_api_ms: 900,
    is_error: false,
    num_turns: 3,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: 0.25,
    usage: partialFake<SuccessMessage["usage"]>(),
    modelUsage: { "claude-opus-5": modelUsage(0.25) },
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-000000000004",
    session_id: SESSION_ID,
    ...overrides,
  });
}

export function errorResult(subtype: string, errors: string[] = []): ErrorMessage {
  const message = partialFake<ErrorMessage>({
    type: "result",
    subtype: "error_during_execution",
    duration_ms: 800,
    duration_api_ms: 500,
    is_error: true,
    num_turns: 2,
    stop_reason: null,
    total_cost_usd: 0.1,
    usage: partialFake<ErrorMessage["usage"]>(),
    modelUsage: { "claude-opus-5": modelUsage(0.1) },
    permission_denials: [],
    errors,
    uuid: "00000000-0000-4000-8000-000000000004",
    session_id: SESSION_ID,
  });
  // Assigned at run time so a test can probe a subtype newer than the SDK types know.
  return Object.assign(message, { subtype });
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
  const state: FakeQuery = { run: runQuery, yielded: [], closed: false, lastOptions: undefined };

  function runQuery(params: Parameters<NonNullable<AgentRunDeps["query"]>>[0]): Query {
    state.lastOptions = params.options;
    const signal = params.options?.abortController?.signal;

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

    const generator = generate();
    const query: Query = partialFake<Query>({
      next: (...args) => generator.next(...args),
      return: (value) => generator.return(value),
      throw: (error) => generator.throw(error),
      [Symbol.asyncIterator]: () => query,
      close: () => {
        state.closed = true;
      },
    });
    return query;
  }

  return state;
}

function untilAborted(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
