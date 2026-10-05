import type { NormalizedObservationOf, NormalizedSessionObservation } from "@titan-design/session-read";
import { findInjectedMarker, toolFamily } from "@titan-design/session-read";
import type { TimelineMessage, TimelineToolCall, TimelineToolOutcome, TimelineTurn, TimelineTurnOrigin } from "./timeline-types.js";

const ERROR_TEXT_CAP = 500;
const SUMMARY_CAP = 160;
const SUMMARY_KEYS = ["command", "pattern", "description", "query", "url", "prompt"] as const;
const PATH_KEYS = ["file_path", "notebook_path", "path"] as const;

export interface CappedText {
  text: string;
  truncated: boolean;
}

export function capText(text: string, cap: number): CappedText {
  return text.length <= cap ? { text, truncated: false } : { text: text.slice(0, cap), truncated: true };
}

export function isSidechain(observation: NormalizedSessionObservation): boolean {
  return observation.nativeExtensions?.some((entry) => entry.name === "isSidechain" && entry.value === true) ?? false;
}

/** Groups messages and tool calls into turns: a user message opens one, and it runs to the next. */
export class TurnFold {
  readonly turns: TimelineTurn[] = [];
  readonly calls: TimelineToolCall[] = [];
  private readonly callsById = new Map<string, TimelineToolCall>();
  private readonly seenMessages = new Set<string>();
  private seq = 0;

  constructor(private readonly maxTextChars: number) {}

  currentIndex(): number | null {
    return this.turns.length > 0 ? this.turns.length - 1 : null;
  }

  message(observation: NormalizedObservationOf<"message">, atMs: number | null): void {
    // A subagent's inlined dialogue belongs to its own transcript, not to this session's turns.
    if (isSidechain(observation) || this.isRepeat(observation)) return;
    const raw = observation.content.map((part) => part.text).join("\n");
    const message: TimelineMessage = {
      role: observation.role,
      seq: this.seq++,
      atMs,
      ...capText(raw, this.maxTextChars),
      byteOffset: observation.evidence.line.byteOffset,
    };
    if (observation.role === "user") this.open(message, raw);
    else touch(this.current(atMs), atMs).assistant.push(message);
  }

  toolCall(observation: NormalizedObservationOf<"tool_call">, atMs: number | null): void {
    const turn = touch(this.current(atMs), atMs);
    const call: TimelineToolCall = {
      id: observation.call.nativeId,
      seq: this.seq++,
      turnIndex: turn.index,
      name: observation.name,
      family: toolFamily(observation.name).family,
      atMs,
      endMs: null,
      durationMs: null,
      outcome: "pending",
      errorMessage: null,
      inputSummary: inputSummary(observation.input),
      filePath: firstString(observation.input, PATH_KEYS),
      sidechain: isSidechain(observation),
      byteOffset: observation.evidence.line.byteOffset,
    };
    turn.toolCalls.push(call);
    this.calls.push(call);
    this.callsById.set(call.id, call);
  }

  /** A result whose call was never seen, as in a resumed slice, is dropped. */
  toolResult(observation: NormalizedObservationOf<"tool_result">, atMs: number | null): void {
    const call = this.callsById.get(observation.call.nativeId);
    const turn = call ? this.turns[call.turnIndex] : undefined;
    if (!call || !turn) return;
    call.endMs = atMs;
    call.durationMs = span(call.atMs, atMs);
    call.outcome = outcomeOf(observation.isError);
    touch(turn, atMs);
    if (call.outcome !== "error") return;
    call.errorMessage = capText(outputText(observation.output), ERROR_TEXT_CAP).text;
    turn.errorCount++;
  }

  private isRepeat(observation: NormalizedObservationOf<"message">): boolean {
    const key = observation.item?.nativeId;
    if (!key) return false;
    if (this.seenMessages.has(key)) return true;
    this.seenMessages.add(key);
    return false;
  }

  private open(user: TimelineMessage, raw: string): void {
    const marker = findInjectedMarker(raw);
    this.turns.push({ ...emptyTurn(this.turns.length, originOf(marker), user.atMs), injectedMarker: marker, user });
  }

  private current(atMs: number | null): TimelineTurn {
    const last = this.turns[this.turns.length - 1];
    if (last) return last;
    const turn = emptyTurn(0, "none", atMs);
    this.turns.push(turn);
    return turn;
  }
}

function emptyTurn(index: number, origin: TimelineTurnOrigin, atMs: number | null): TimelineTurn {
  return {
    index,
    origin,
    injectedMarker: null,
    startMs: atMs,
    endMs: atMs,
    gapBeforeMs: null,
    user: null,
    assistant: [],
    toolCalls: [],
    errorCount: 0,
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 },
    costUsd: 0,
  };
}

function originOf(marker: string | null): TimelineTurnOrigin {
  if (marker === null) return "prompt";
  return marker === "compaction_summary" ? "compaction" : "injected";
}

function touch(turn: TimelineTurn, atMs: number | null): TimelineTurn {
  if (atMs === null) return turn;
  if (turn.startMs === null || atMs < turn.startMs) turn.startMs = atMs;
  if (turn.endMs === null || atMs > turn.endMs) turn.endMs = atMs;
  return turn;
}

function span(startMs: number | null, endMs: number | null): number | null {
  if (startMs === null || endMs === null || endMs < startMs) return null;
  return endMs - startMs;
}

function outcomeOf(isError: boolean | null): TimelineToolOutcome {
  if (isError === null) return "unknown";
  return isError ? "error" : "success";
}

function firstString(input: unknown, keys: readonly string[]): string | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function inputSummary(input: unknown): string {
  const text = firstString(input, PATH_KEYS) ?? firstString(input, SUMMARY_KEYS) ?? "";
  const firstLine = text.split("\n", 1)[0] ?? "";
  return capText(firstLine, SUMMARY_CAP).text;
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  for (const block of output) {
    const text = firstString(block, ["text"]);
    if (text) return text;
  }
  return "";
}
