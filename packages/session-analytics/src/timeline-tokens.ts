import type { TokenCounts, UsageMeasurement } from "@titan-design/agent-protocol";
import { foldUsage } from "@titan-design/agent-protocol";
import type { NormalizedObservationOf } from "@titan-design/session-read";
import type { PriceRow } from "./prices.js";
import { priceRequest } from "./price-request.js";
import type { CompactionMark, ModelRequests, TimelineTokens, TimelineTokenPoint, TokenTimeline } from "./timeline-types.js";
import { capText } from "./timeline-turns.js";

type Snapshot = Extract<UsageMeasurement, { kind: "snapshot" }>;

/** One deduplicated API request, before the cumulative pass. */
export interface TokenRequest {
  atMs: number | null;
  turnIndex: number | null;
  model: string | null;
  contextTokens: number | null;
  tokens: TimelineTokens;
  costUsd: number;
  priced: boolean;
  afterCompaction: boolean;
}

export interface TokenFoldResult {
  timeline: TokenTimeline;
  /** Every request, timed or not; empty on a snapshot basis. */
  requests: TokenRequest[];
  /** Null when the basis cannot count requests. */
  requestCount: number | null;
  tokens: TimelineTokens;
}

export function emptyTokens(): TimelineTokens {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

export function addTokens(into: TimelineTokens, from: TimelineTokens): void {
  into.input += from.input;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.output += from.output;
}

/** Folds usage and compaction observations into the token series. */
export class TokenFold {
  readonly compactions: CompactionMark[] = [];
  private readonly requests = new Map<string, TokenRequest>();
  private readonly snapshots: Snapshot[] = [];
  private compactedSinceRequest = false;

  constructor(
    private readonly maxTextChars: number,
    private readonly prices: readonly PriceRow[] | undefined,
  ) {}

  usage(observation: NormalizedObservationOf<"usage">, atMs: number | null, turnIndex: number | null): void {
    const { measurement } = observation;
    if (measurement.kind === "snapshot") {
      this.snapshots.push(measurement);
      return;
    }
    // A response written over several lines repeats its usage; the last line holds the final counts.
    const held = this.requests.get(measurement.responseId);
    const tokens = disjointTokens(measurement.tokens);
    const priced = priceRequest(priceInput(tokens), measurement.model ?? "", isoOf(held ? held.atMs : atMs), this.prices);
    this.requests.set(measurement.responseId, {
      atMs: held ? held.atMs : atMs,
      turnIndex: held ? held.turnIndex : turnIndex,
      model: measurement.model,
      contextTokens: measurement.tokens.input,
      tokens,
      costUsd: priced.costUsd,
      priced: priced.priced,
      afterCompaction: held ? held.afterCompaction : this.takeCompactionFlag(),
    });
  }

  /**
   * Claude Code writes one compaction as a boundary line and then a summary line, and the
   * decoder reports both. The second joins the first: the mark keeps the boundary's time and gains the summary.
   */
  compaction(observation: NormalizedObservationOf<"compaction">, atMs: number | null, turnIndex: number | null): void {
    const summary = observation.nativeExtensions?.find((entry) => entry.name === "compactionSummary")?.value;
    const capped = typeof summary === "string" ? capText(summary, this.maxTextChars) : null;
    const open = this.compactedSinceRequest ? this.compactions.at(-1) : undefined;
    if (open && open.summary === null) {
      open.summary = capped?.text ?? null;
      open.summaryTruncated = capped?.truncated ?? false;
      return;
    }
    this.compactions.push({
      atMs,
      turnIndex,
      byteOffset: observation.evidence.line.byteOffset,
      summary: capped?.text ?? null,
      summaryTruncated: capped?.truncated ?? false,
    });
    this.compactedSinceRequest = true;
  }

  result(): TokenFoldResult {
    const requests = [...this.requests.values()];
    const basis = requests.length > 0 ? "delta" : this.snapshots.length > 0 ? "snapshot" : "unreported";
    const timeline: TokenTimeline = { basis, points: cumulativePoints(requests), compactions: this.compactions, models: modelCounts(requests) };
    if (basis === "snapshot") return { timeline, requests, requestCount: null, tokens: snapshotTokens(this.snapshots) };
    const tokens = emptyTokens();
    for (const request of requests) addTokens(tokens, request.tokens);
    return { timeline, requests, requestCount: requests.length, tokens };
  }

  private takeCompactionFlag(): boolean {
    const flag = this.compactedSinceRequest;
    this.compactedSinceRequest = false;
    return flag;
  }
}

/** Both decoders report `input` as the whole prompt, so cache reads and writes come out of it. */
function disjointTokens(counts: TokenCounts): TimelineTokens {
  const cacheRead = counts.cachedInput ?? 0;
  const cacheWrite = counts.cacheWriteInput ?? 0;
  return { input: Math.max(0, (counts.input ?? 0) - cacheRead - cacheWrite), cacheRead, cacheWrite, output: counts.output ?? 0 };
}

function priceInput(tokens: TimelineTokens) {
  return { inputTokens: tokens.input, cacheReadTokens: tokens.cacheRead, cacheCreationTokens: tokens.cacheWrite, outputTokens: tokens.output };
}

function isoOf(atMs: number | null): string {
  return atMs === null ? "" : new Date(atMs).toISOString();
}

function cumulativePoints(requests: readonly TokenRequest[]): TimelineTokenPoint[] {
  const points: TimelineTokenPoint[] = [];
  let cumulativeOutputTokens = 0;
  let cumulativeCostUsd = 0;
  for (const request of requests) {
    cumulativeOutputTokens += request.tokens.output;
    cumulativeCostUsd += request.costUsd;
    if (request.atMs === null) continue;
    const { atMs, turnIndex, model, contextTokens, costUsd, priced, afterCompaction } = request;
    points.push({ atMs, turnIndex, model, contextTokens, outputTokens: request.tokens.output, cumulativeOutputTokens, costUsd, cumulativeCostUsd, priced, afterCompaction });
  }
  return points;
}

function modelCounts(requests: readonly TokenRequest[]): ModelRequests[] {
  const counts = new Map<string, number>();
  for (const request of requests) {
    if (request.model) counts.set(request.model, (counts.get(request.model) ?? 0) + 1);
  }
  return [...counts]
    .map(([model, count]) => ({ model, requests: count }))
    .sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model));
}

function snapshotTokens(snapshots: readonly Snapshot[]): TimelineTokens {
  const tokens = emptyTokens();
  for (const measurement of foldUsage(snapshots).measurements) addTokens(tokens, disjointTokens(measurement.tokens));
  return tokens;
}
