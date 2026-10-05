import type { ToolFamily } from "@titan-design/session-read";

/** Bump when a field is removed or changes meaning. Adding a field keeps the version. */
export const SESSION_TIMELINE_VERSION = 1;

/** Idle time between two events that counts as a gap. */
export const TIMELINE_GAP_MIN_MS = 10 * 60_000;

/** Default cap on each message text. The byte offset still points at the full record. */
export const TIMELINE_TEXT_CAP = 4_000;

/** `prompt` is typed or sent text, `injected` is a harness block, `compaction` is a continuation summary, `none` is activity before any user message. */
export type TimelineTurnOrigin = "prompt" | "injected" | "compaction" | "none";

/** `unknown` is a result whose source did not report an error state; `pending` has no result yet. */
export type TimelineToolOutcome = "success" | "error" | "unknown" | "pending";

export interface TimelineMessage {
  role: "user" | "assistant";
  /** Source order across the whole session; sort a turn's messages and tool calls by it to interleave them. */
  seq: number;
  atMs: number | null;
  text: string;
  /** True when `text` was cut at the cap. */
  truncated: boolean;
  /** Offset of the transcript line, for reading the full record. */
  byteOffset: number;
}

export interface TimelineToolCall {
  /** The harness's own call id, unique within the session. */
  id: string;
  seq: number;
  turnIndex: number;
  name: string;
  family: ToolFamily;
  atMs: number | null;
  /** When the result arrived; null while pending. */
  endMs: number | null;
  /** Observed call-to-result span, not harness execution time. */
  durationMs: number | null;
  outcome: TimelineToolOutcome;
  errorMessage: string | null;
  /** One line naming what the call acted on: a path, a command, a pattern or a description. */
  inputSummary: string;
  filePath: string | null;
  sidechain: boolean;
  byteOffset: number;
}

/** Prompt-side counts are disjoint: `input` excludes cache reads and cache writes. */
export interface TimelineTokens {
  input: number;
  cacheRead: number;
  /** All cache writes, `cacheWrite5m + cacheWrite1h`. */
  cacheWrite: number;
  /** Writes at the 5m rate, including a total the source reported without a split. */
  cacheWrite5m: number;
  /** Writes at the 1h rate. */
  cacheWrite1h: number;
  output: number;
}

export interface TimelineTurn {
  index: number;
  origin: TimelineTurnOrigin;
  /** The session-read injected-marker name when `origin` is `injected` or `compaction`. */
  injectedMarker: string | null;
  startMs: number | null;
  endMs: number | null;
  /** Idle time before this turn when it is `TIMELINE_GAP_MIN_MS` or more, else null. */
  gapBeforeMs: number | null;
  /** The message that opened the turn; null when `origin` is `none`. */
  user: TimelineMessage | null;
  assistant: TimelineMessage[];
  toolCalls: TimelineToolCall[];
  errorCount: number;
  tokens: TimelineTokens;
  costUsd: number;
}

/** One UTC clock minute that held activity. Minutes with none are omitted. */
export interface TimelineMinuteBucket {
  /** Start of the minute. */
  minuteMs: number;
  /** Messages, tool calls and tool results. */
  events: number;
  messages: number;
  toolCalls: number;
  errors: number;
  outputTokens: number;
  costUsd: number;
  /** Set on the first bucket after a gap. */
  gapBeforeMs: number | null;
}

/** An idle stretch. Time spent waiting on a tool call that later returned is not idle, so it is never a gap. */
export interface TimelineGap {
  startMs: number;
  endMs: number;
  durationMs: number;
}

/** One API request. Points are in source order and cumulative fields run over that order. */
export interface TimelineTokenPoint {
  atMs: number;
  turnIndex: number | null;
  model: string | null;
  /** The prompt size of this request: input plus cache read plus cache write. Null when the source omitted a count. */
  contextTokens: number | null;
  outputTokens: number;
  cumulativeOutputTokens: number;
  costUsd: number;
  cumulativeCostUsd: number;
  /** False when no price row covers the model; `costUsd` is then 0. */
  priced: boolean;
  /** True on the first request after a compaction. */
  afterCompaction: boolean;
}

export interface CompactionMark {
  atMs: number | null;
  turnIndex: number | null;
  byteOffset: number;
  summary: string | null;
  summaryTruncated: boolean;
}

export interface ModelRequests {
  model: string;
  requests: number;
}

export interface TokenTimeline {
  /** `delta` has per-request points. A `snapshot` source reports running totals only: `points` is empty and nothing is priced, so every `costUsd` is 0. */
  basis: "delta" | "snapshot" | "unreported";
  points: TimelineTokenPoint[];
  compactions: CompactionMark[];
  /** Most requests first. */
  models: ModelRequests[];
}

export interface ToolNameCount {
  name: string;
  family: ToolFamily;
  calls: number;
  errors: number;
  durationMs: number;
}

export interface ToolFamilyCount {
  family: ToolFamily;
  calls: number;
  errors: number;
  /** Call start times, ascending, for `countAtOrBefore`. */
  atMs: number[];
}

export interface TimelineToolBreakdown {
  /** Most calls first. */
  byName: ToolNameCount[];
  byFamily: ToolFamilyCount[];
  /** Every call start time, ascending. */
  atMs: number[];
}

export interface TimelineFileTouch {
  path: string;
  access: "read" | "write";
  /** First touch of this path with this access. */
  atMs: number | null;
  calls: number;
}

export interface TimelineFileBreakdown {
  /** One row per path and access, ordered by first touch. */
  touches: TimelineFileTouch[];
  readCount: number;
  writeCount: number;
}

export interface TimelineError {
  callId: string;
  toolName: string;
  turnIndex: number;
  /** When the failing result arrived. */
  atMs: number | null;
  message: string;
  sidechain: boolean;
}

export interface TimelineErrorBreakdown {
  /** Failed calls over all calls; 0 with no calls. */
  rate: number;
  items: TimelineError[];
  atMs: number[];
}

/** A subagent dispatch, from its tool call to that call's result. */
export interface TimelineAgentSpan {
  callId: string;
  label: string;
  startMs: number | null;
  endMs: number | null;
  outcome: TimelineToolOutcome;
}

export interface TimelineTotals {
  turns: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  errors: number;
  compactions: number;
  /** API requests with usage. Null on a `snapshot` basis, which cannot count them. */
  requests: number | null;
  unpricedRequests: number;
  tokens: TimelineTokens;
  /** 0 on a `snapshot` basis, which has no per-request usage to price. */
  costUsd: number;
}

/**
 * Everything a session view reads, as plain JSON. Every `*Ms` field is epoch milliseconds,
 * so the model holds no time zone and a renderer picks one.
 */
export interface SessionTimeline {
  version: typeof SESSION_TIMELINE_VERSION;
  sessionId: string | null;
  harness: string | null;
  startMs: number | null;
  endMs: number | null;
  durationMs: number;
  totals: TimelineTotals;
  turns: TimelineTurn[];
  buckets: TimelineMinuteBucket[];
  gaps: TimelineGap[];
  tokens: TokenTimeline;
  tools: TimelineToolBreakdown;
  files: TimelineFileBreakdown;
  errors: TimelineErrorBreakdown;
  agents: TimelineAgentSpan[];
}
