import { closeSync, fstatSync, openSync, readSync } from "node:fs";

type Json = Record<string, unknown>;

const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const asObject = (value: unknown): Json | null => (isJson(value) ? value : null);

function str(source: Json | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function blocks(message: Json | null): Json[] {
  const content = message?.content;
  return Array.isArray(content) ? content.map(asObject).filter((b): b is Json => b !== null) : [];
}

/**
 * Whether a Claude Code session is between turns, read from its transcript tail.
 *
 * `idle` means the main chain's newest conversational record ended a turn, so nothing is
 * running and nothing is queued; `sinceMs` is when that turn ended. Every doubt reads as
 * `busy` or `unknown`, never `idle`, because a caller that acts on `idle` may inject a prompt.
 */
export type TurnState =
  | { kind: "idle"; sinceMs: number }
  | { kind: "busy" }
  | { kind: "unknown"; reason: string };

/** A tail this wide holds the newest records even after a large tool result. */
const TURN_STATE_TAIL_BYTES = 1024 * 1024;

const ENDED = new Set(["end_turn", "stop_sequence"]);
const INTERRUPTED = "[Request interrupted by user";

/** Pure: the turn state the newest main-chain record implies; records are oldest first. */
export function claudeTurnState(records: readonly unknown[]): TurnState {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = asObject(records[i]);
    if (record === null || record.isSidechain === true) continue;
    const state = stateOf(record);
    if (state !== undefined) return state;
  }
  return { kind: "unknown", reason: "no conversational record in the tail" };
}

/** Undefined for bookkeeping records (system lines, titles, request blobs) that say nothing about the turn. */
function stateOf(record: Json): TurnState | undefined {
  switch (record.type) {
    case "queue-operation":
      return record.operation === "enqueue" || record.operation === "dequeue" ? { kind: "busy" } : undefined;
    case "assistant":
      return ENDED.has(str(asObject(record.message), "stop_reason") ?? "") ? idleAt(record) : { kind: "busy" };
    case "user":
      return isInterrupt(record) ? idleAt(record) : { kind: "busy" };
    default:
      return undefined;
  }
}

function idleAt(record: Json): TurnState {
  const sinceMs = Date.parse(str(record, "timestamp") ?? "");
  return Number.isFinite(sinceMs) ? { kind: "idle", sinceMs } : { kind: "unknown", reason: "turn end has no timestamp" };
}

/** An interrupted turn ends on the user's interrupt marker, with no assistant reply after it. */
function isInterrupt(record: Json): boolean {
  const message = asObject(record.message);
  if (typeof message?.content === "string") return message.content.startsWith(INTERRUPTED);
  return blocks(message).some((block) => block.type === "text" && (str(block, "text") ?? "").startsWith(INTERRUPTED));
}

/** Reads the transcript's tail and classifies it; an unreadable file is `unknown`, never `idle`. */
export function readClaudeTurnState(filePath: string, maxBytes = TURN_STATE_TAIL_BYTES): TurnState {
  try {
    return claudeTurnState(completeLines(readTail(filePath, maxBytes)).map(parseRecord));
  } catch (error) {
    return { kind: "unknown", reason: `could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

interface Tail {
  text: string;
  truncatedBefore: boolean;
}

function readTail(filePath: string, maxBytes: number): Tail {
  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const bytes = Buffer.alloc(length);
    const read = readSync(fd, bytes, 0, length, size - length);
    return { text: bytes.subarray(0, read).toString("utf8"), truncatedBefore: size > maxBytes };
  } finally {
    closeSync(fd);
  }
}

/** Drops a line cut by the window's start and a final line Claude Code is still writing. */
function completeLines({ text, truncatedBefore }: Tail): string[] {
  const lines = text.split("\n");
  lines.pop();
  return truncatedBefore ? lines.slice(1) : lines;
}

function parseRecord(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
