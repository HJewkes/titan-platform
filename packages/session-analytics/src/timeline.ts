import type { NormalizedSessionObservation } from "@titan-design/session-read";
import type { PriceRow } from "./prices.js";
import { agentSpans, errorBreakdown, fileBreakdown, toolBreakdown } from "./timeline-breakdowns.js";
import { activityTimes, findGaps, markTurnGaps, minuteBuckets } from "./timeline-buckets.js";
import type { TokenFoldResult } from "./timeline-tokens.js";
import { TokenFold, addTokens, emptyTokens } from "./timeline-tokens.js";
import { TurnFold } from "./timeline-turns.js";
import type { SessionTimeline, TimelineTotals, TimelineTurn } from "./timeline-types.js";
import { SESSION_TIMELINE_VERSION, TIMELINE_GAP_MIN_MS, TIMELINE_TEXT_CAP } from "./timeline-types.js";

export interface SessionTimelineOptions {
  /** Idle time that counts as a gap. Defaults to `TIMELINE_GAP_MIN_MS`. */
  gapMinMs?: number;
  /** Cap on each message and compaction summary. Defaults to `TIMELINE_TEXT_CAP`. */
  maxTextChars?: number;
  /** Price rows for the cost series. Defaults to `PRICE_TABLE`. */
  prices?: readonly PriceRow[];
}

/** Storage-free fold for a streamed read: `add` each observation, then `result`, which returns a fresh copy each time. */
export class SessionTimelineAccumulator {
  private readonly turns: TurnFold;
  private readonly tokens: TokenFold;
  private readonly gapMinMs: number;
  private conversation: NormalizedSessionObservation["conversation"] | null = null;
  private startMs: number | null = null;
  private endMs: number | null = null;

  constructor(options: SessionTimelineOptions = {}) {
    const maxTextChars = options.maxTextChars ?? TIMELINE_TEXT_CAP;
    this.gapMinMs = options.gapMinMs ?? TIMELINE_GAP_MIN_MS;
    this.turns = new TurnFold(maxTextChars);
    this.tokens = new TokenFold(maxTextChars, options.prices);
  }

  add(observation: NormalizedSessionObservation): void {
    this.claim(observation);
    // History copied in from a parent conversation is that conversation's activity, not this one's.
    if (observation.historyOrigin) return;
    const atMs = this.clock(observation.timestamp);
    if (observation.kind === "message") this.turns.message(observation, atMs);
    if (observation.kind === "tool_call") this.turns.toolCall(observation, atMs);
    if (observation.kind === "tool_result") this.turns.toolResult(observation, atMs);
    if (observation.kind === "usage") this.tokens.usage(observation, atMs, this.turns.currentIndex());
    if (observation.kind === "compaction") this.tokens.compaction(observation, atMs, this.turns.currentIndex());
  }

  result(): SessionTimeline {
    const { turns, calls } = this.turns;
    const tokens = this.tokens.result();
    attributeRequests(turns, tokens);
    markTurnGaps(turns, this.gapMinMs);
    const bucketInput = { turns, calls, points: tokens.timeline.points };
    const gaps = findGaps(activityTimes(bucketInput), this.gapMinMs, calls);
    const errors = errorBreakdown(calls);
    // A copy, so a later `add` cannot change a result the caller already holds.
    return structuredClone<SessionTimeline>({
      version: SESSION_TIMELINE_VERSION,
      sessionId: this.conversation?.nativeId ?? null,
      harness: this.conversation?.harness ?? null,
      startMs: this.startMs,
      endMs: this.endMs,
      durationMs: this.startMs !== null && this.endMs !== null ? this.endMs - this.startMs : 0,
      totals: totalsOf(turns, calls.length, errors.items.length, tokens),
      turns,
      buckets: minuteBuckets(bucketInput, gaps),
      gaps,
      tokens: tokens.timeline,
      tools: toolBreakdown(calls),
      files: fileBreakdown(calls),
      errors,
      agents: agentSpans(calls),
    });
  }

  private claim(observation: NormalizedSessionObservation): void {
    const { harness, namespace, nativeId } = observation.conversation;
    this.conversation ??= observation.conversation;
    const held = this.conversation;
    if (held.harness !== harness || held.namespace !== namespace || held.nativeId !== nativeId) {
      throw new TypeError("cannot build one timeline from observations of different conversations");
    }
  }

  /** A record with no usable timestamp takes the latest one seen, so it still lands in order. */
  private clock(timestamp: string | null): number | null {
    const parsed = timestamp === null ? Number.NaN : Date.parse(timestamp);
    if (!Number.isFinite(parsed)) return this.endMs;
    if (this.startMs === null || parsed < this.startMs) this.startMs = parsed;
    if (this.endMs === null || parsed > this.endMs) this.endMs = parsed;
    return parsed;
  }
}

/** The read model behind every session view: turns, minute buckets, the token and cost series, and tool, file and error breakdowns. */
export function buildSessionTimeline(
  observations: Iterable<NormalizedSessionObservation>,
  options: SessionTimelineOptions = {},
): SessionTimeline {
  const accumulator = new SessionTimelineAccumulator(options);
  for (const observation of observations) accumulator.add(observation);
  return accumulator.result();
}

/** Rebuilds each turn's sums from scratch, so `result` can run more than once. */
function attributeRequests(turns: readonly TimelineTurn[], tokens: TokenFoldResult): void {
  for (const turn of turns) {
    turn.tokens = emptyTokens();
    turn.costUsd = 0;
  }
  for (const request of tokens.requests) {
    const turn = request.turnIndex === null ? undefined : turns[request.turnIndex];
    if (!turn) continue;
    addTokens(turn.tokens, request.tokens);
    turn.costUsd += request.costUsd;
  }
}

function totalsOf(turns: readonly TimelineTurn[], toolCalls: number, errors: number, tokens: TokenFoldResult): TimelineTotals {
  return {
    turns: turns.length,
    userMessages: turns.filter((turn) => turn.user !== null).length,
    assistantMessages: turns.reduce((sum, turn) => sum + turn.assistant.length, 0),
    toolCalls,
    errors,
    compactions: tokens.timeline.compactions.length,
    requests: tokens.requestCount,
    unpricedRequests: tokens.requests.filter((request) => !request.priced).length,
    tokens: tokens.tokens,
    costUsd: tokens.requests.reduce((sum, request) => sum + request.costUsd, 0),
  };
}
