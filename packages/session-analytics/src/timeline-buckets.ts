import type { TimelineMinuteBucket, TimelineGap, TimelineToolCall, TimelineTurn, TimelineTokenPoint } from "./timeline-types.js";

const MINUTE_MS = 60_000;

export interface BucketInput {
  turns: readonly TimelineTurn[];
  calls: readonly TimelineToolCall[];
  points: readonly TimelineTokenPoint[];
}

/** Every timed message, tool call, tool result and request, ascending. */
export function activityTimes(input: BucketInput): number[] {
  const times: (number | null)[] = input.points.map((point) => point.atMs);
  for (const turn of input.turns) {
    times.push(turn.user?.atMs ?? null, ...turn.assistant.map((message) => message.atMs));
  }
  for (const call of input.calls) times.push(call.atMs, call.endMs);
  return times.filter((time): time is number => time !== null).sort((a, b) => a - b);
}

/** A quiet stretch covered by a tool call that later returned is work in flight, not a gap. */
export function findGaps(sortedMs: readonly number[], gapMinMs: number, calls: readonly TimelineToolCall[]): TimelineGap[] {
  const gaps: TimelineGap[] = [];
  for (let i = 1; i < sortedMs.length; i++) {
    const startMs = sortedMs[i - 1] as number;
    const endMs = sortedMs[i] as number;
    if (endMs - startMs < gapMinMs || calls.some((call) => inFlightAcross(call, startMs, endMs))) continue;
    gaps.push({ startMs, endMs, durationMs: endMs - startMs });
  }
  return gaps;
}

function inFlightAcross(call: TimelineToolCall, startMs: number, endMs: number): boolean {
  return call.atMs !== null && call.endMs !== null && call.atMs <= startMs && call.endMs >= endMs;
}

/**
 * Buckets by epoch minute. Every real zone offset is a whole number of minutes, so an epoch
 * minute is a clock minute in any zone and a session that crosses midnight needs no date math.
 */
export function minuteBuckets(input: BucketInput, gaps: readonly TimelineGap[]): TimelineMinuteBucket[] {
  const buckets = new Map<number, TimelineMinuteBucket>();
  const at = (ms: number) => bucketAt(buckets, ms);
  for (const turn of input.turns) {
    for (const message of [turn.user, ...turn.assistant]) {
      if (message?.atMs != null) countEvent(at(message.atMs), "messages");
    }
  }
  for (const call of input.calls) countCall(call, at);
  for (const point of input.points) {
    const bucket = at(point.atMs);
    bucket.outputTokens += point.outputTokens;
    bucket.costUsd += point.costUsd;
  }
  for (const gap of gaps) at(gap.endMs).gapBeforeMs = gap.durationMs;
  return [...buckets.values()].sort((a, b) => a.minuteMs - b.minuteMs);
}

/** Marks each turn that opens after an idle stretch, measured from the previous turn's last event. */
export function markTurnGaps(turns: readonly TimelineTurn[], gapMinMs: number): void {
  let previousEndMs: number | null = null;
  for (const turn of turns) {
    const idleMs = previousEndMs !== null && turn.startMs !== null ? turn.startMs - previousEndMs : 0;
    turn.gapBeforeMs = idleMs >= gapMinMs ? idleMs : null;
    previousEndMs = turn.endMs ?? previousEndMs;
  }
}

function bucketAt(buckets: Map<number, TimelineMinuteBucket>, ms: number): TimelineMinuteBucket {
  const minuteMs = Math.floor(ms / MINUTE_MS) * MINUTE_MS;
  let bucket = buckets.get(minuteMs);
  if (!bucket) {
    bucket = { minuteMs, events: 0, messages: 0, toolCalls: 0, errors: 0, outputTokens: 0, costUsd: 0, gapBeforeMs: null };
    buckets.set(minuteMs, bucket);
  }
  return bucket;
}

function countEvent(bucket: TimelineMinuteBucket, field: "messages" | "toolCalls" | null): void {
  bucket.events++;
  if (field) bucket[field]++;
}

function countCall(call: TimelineToolCall, at: (ms: number) => TimelineMinuteBucket): void {
  if (call.atMs !== null) countEvent(at(call.atMs), "toolCalls");
  if (call.endMs !== null) countEvent(at(call.endMs), null);
  const errorMs = call.endMs ?? call.atMs;
  if (call.outcome === "error" && errorMs !== null) at(errorMs).errors++;
}
