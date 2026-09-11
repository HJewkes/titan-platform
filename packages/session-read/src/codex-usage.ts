import type { TokenCounts, UsageMeasurement } from "@titan-design/agent-protocol";
import { CodexUsageState } from "./codex-usage-state.js";
import { asObject, str, type Json } from "./text.js";

export interface CodexUsageEmission {
  path: readonly (string | number)[];
  measurement: UsageMeasurement;
  responseId: string | null;
  turnId: string | null;
}

/** Converts raw response deltas and cumulative projections without mixing their accounting semantics. */
export class CodexUsageDecoder {
  private readonly state = new CodexUsageState();

  constructor(
    private readonly sourceId: string,
    private readonly conversationId: string,
  ) {}

  raw(payload: Json | null, model: string | null, sequence: number): CodexUsageEmission[] {
    if (!payload) return [];
    const turnId = str(payload, "turn_id");
    const responseId = str(payload, "response_id");
    const delta = tokenCounts(asObject(payload.usage));
    const turn = tokenCounts(asObject(payload.turn_token_usage));
    const conversation = tokenCounts(asObject(payload.thread_token_usage));
    if (conversation) this.state.observeRawConversation(conversation);
    const out: CodexUsageEmission[] = [];
    if (responseId && delta) out.push(this.delta(responseId, turnId, model, delta));
    if (turnId && turn) out.push(this.snapshot("turn", turnId, turnId, model, turn, sequence, "token_usage_record.turn_token_usage"));
    if (conversation) out.push(this.snapshot("conversation", this.conversationId, turnId, null, conversation, sequence, "token_usage_record.thread_token_usage"));
    return out;
  }

  projected(payload: Json | null, turnId: string | null, sequence: number): CodexUsageEmission[] {
    const tokens = tokenCounts(asObject(asObject(payload?.info)?.total_token_usage));
    if (!tokens || !this.state.shouldUseProjection(tokens)) return [];
    this.state.observeConversation(tokens.total);
    return [this.snapshot("conversation", this.conversationId, turnId, null, tokens, sequence, "event_msg.token_count.info.total_token_usage")];
  }

  compact(): void {
    this.state.compact();
  }

  epoch(): string {
    return this.state.epoch(this.sourceId);
  }

  private delta(responseId: string, turnId: string | null, model: string | null, tokens: TokenCounts): CodexUsageEmission {
    return {
      path: ["payload", "usage"],
      measurement: { kind: "delta", responseId, model, tokens, cost: null, source: "token_usage_record.usage" },
      responseId,
      turnId,
    };
  }

  private snapshot(scope: "turn" | "conversation", scopeId: string, turnId: string | null, model: string | null, tokens: TokenCounts, sequence: number, source: string): CodexUsageEmission {
    const field = source.slice(source.lastIndexOf(".") + 1);
    return {
      path: source.startsWith("event_msg") ? ["payload", "info", field] : ["payload", field],
      measurement: { kind: "snapshot", scope, scopeId, epoch: this.epoch(), sequence, model, tokens, cost: null, source },
      responseId: null,
      turnId,
    };
  }
}

function tokenCounts(source: Json | null): TokenCounts | null {
  if (!source) return null;
  return {
    input: token(source.input_tokens),
    output: token(source.output_tokens),
    cachedInput: token(source.cached_input_tokens),
    cacheWriteInput: token(source.cache_write_input_tokens),
    reasoningOutput: token(source.reasoning_output_tokens),
    total: token(source.total_tokens),
  };
}

function token(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
