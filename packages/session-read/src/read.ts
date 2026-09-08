import path from "node:path";
import { nextOffset, prefixHash, readJsonLines } from "@titan-design/locator";
import type { SessionEvent } from "./events.js";
import { EventFolder, type TranscriptDelta } from "./fold.js";
import { LineReader } from "./line-reader.js";
import { asObject } from "./text.js";

export interface ReadOptions {
  /** Resume point; must be a line boundary. */
  fromByteOffset?: number;
  /** Stop after this offset, for tests simulating a partially grown file. */
  untilByteOffset?: number;
  /** Set for subagent sidechains, whose lines carry their parent's `sessionId`. */
  subagentId?: string | null;
  /** Session id for lines that carry none; defaults to the filename stem. */
  fallbackSessionId?: string | null;
}

/** A malformed JSON line aborts the transcript so the caller can quarantine it. */
export class TranscriptParseError extends Error {
  constructor(
    readonly filePath: string,
    readonly byteOffset: number,
    cause: unknown,
  ) {
    super(`malformed JSON at ${filePath}:${byteOffset}: ${String(cause)}`);
    this.name = "TranscriptParseError";
  }
}

export interface ReadResult {
  /** Watermark to store: the byte after the last complete line consumed. */
  lastByteOffset: number;
  startByteOffset: number;
}

/**
 * Stream typed events from a transcript, starting at a watermark. The final
 * `lastByteOffset` is reported through `onDone` so a consumer that only
 * iterates events still learns where to resume.
 */
export async function* readTranscriptEvents(
  filePath: string,
  options: ReadOptions = {},
  onDone?: (result: ReadResult) => void,
): AsyncGenerator<SessionEvent> {
  const start = options.fromByteOffset ?? 0;
  const fallback = options.fallbackSessionId === undefined ? path.basename(filePath, ".jsonl") : options.fallbackSessionId;
  const pending: SessionEvent[] = [];
  const reader = new LineReader((event) => pending.push(event), fallback, options.subagentId ?? null);
  let offset = start;
  for await (const line of readJsonLines(filePath, start)) {
    const trimmed = line.text.trim();
    if (trimmed.length > 0) {
      const parsed = parseLine(filePath, line.byteOffset, trimmed);
      if (parsed) reader.handle(parsed, { byteOffset: line.byteOffset, byteLength: line.byteLength });
    }
    offset = nextOffset(line);
    yield* pending.splice(0);
    if (options.untilByteOffset !== undefined && offset >= options.untilByteOffset) break;
  }
  onDone?.({ lastByteOffset: offset, startByteOffset: start });
}

function parseLine(filePath: string, byteOffset: number, text: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(text));
  } catch (err) {
    throw new TranscriptParseError(filePath, byteOffset, err);
  }
}

export interface ExtractOptions extends ReadOptions {
  /** The stored prefix hash; a mismatch forces a full re-read from byte 0. */
  priorPrefixHash?: string | null;
}

export interface ExtractResult extends TranscriptDelta, ReadResult {
  restartedFromZero: boolean;
  /** Hash of bytes `[0, lastByteOffset)`, to store beside the watermark. */
  prefixHash: string;
}

/** Read from the watermark (or byte 0 after a rewrite) and fold the events into one delta. */
export async function extractTranscript(filePath: string, options: ExtractOptions = {}): Promise<ExtractResult> {
  const requested = options.fromByteOffset ?? 0;
  const restartedFromZero =
    requested > 0 && !!options.priorPrefixHash && (await prefixHash(filePath, requested)) !== options.priorPrefixHash;
  const readOptions = { ...options, fromByteOffset: restartedFromZero ? 0 : requested };
  const folder = new EventFolder();
  let done: ReadResult = { lastByteOffset: readOptions.fromByteOffset, startByteOffset: readOptions.fromByteOffset };
  for await (const event of readTranscriptEvents(filePath, readOptions, (r) => (done = r))) folder.fold(event);
  return { ...folder.result(), ...done, restartedFromZero, prefixHash: await prefixHash(filePath, done.lastByteOffset) };
}
