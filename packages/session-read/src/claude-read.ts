import { createHash } from "node:crypto";
import { readLocatorBytes } from "@titan-design/locator";
import { isStaleLine } from "./absent.js";
import { ClaudeTranscriptDecoder } from "./claude-decoder.js";
import { assertClaudeSessionSource, claudeRecordBelongsToSource, CLAUDE_TRANSCRIPT_FORMAT } from "./claude-source.js";
import type { NormalizedSessionObservation, SessionSourceDescriptor, SourceTextLocator } from "./normalized.js";
import { resolveSource, selectedText, streamObservations } from "./observation-stream.js";
import type { ReadSessionObservationOptions, SessionObservationReadResult } from "./session-observations.js";

export interface ReadClaudeTextOptions {
  /** Fresh lookup results let callers resolve a moved source by stable source ID. */
  sources?: readonly SessionSourceDescriptor[];
}

/** Prefix-replay reader with bounded observation buffering and rewrite detection. */
export async function* readClaudeObservations(
  source: SessionSourceDescriptor,
  options: ReadSessionObservationOptions = {},
  onDone?: (result: SessionObservationReadResult) => void,
): AsyncGenerator<NormalizedSessionObservation> {
  assertClaudeSessionSource(source);
  yield* streamObservations(source, new ClaudeTranscriptDecoder(), options, onDone);
}

/** Read one selected semantic field from a Claude transcript locator. */
export async function readClaudeText(locator: SourceTextLocator, options: ReadClaudeTextOptions = {}): Promise<string | null> {
  if (locator.source.format !== CLAUDE_TRANSCRIPT_FORMAT || locator.source.harness !== "claude-code") return null;
  const source = resolveSource(locator, options.sources);
  if (!source || !isClaudeSessionSource(source)) return null;
  try {
    return await readSelectedText(source, locator);
  } catch (error) {
    if (isStaleLine(error)) return null;
    throw error;
  }
}

async function readSelectedText(source: SessionSourceDescriptor, locator: SourceTextLocator): Promise<string | null> {
  const bytes = await readLocatorBytes(source.path, [0, locator.evidence.line.byteOffset, locator.evidence.line.byteLength]);
  if (hashBytes(bytes) !== locator.evidence.line.contentHash) return null;
  const line = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const record = JSON.parse(line) as unknown;
  if (typeof record !== "object" || record === null || Array.isArray(record) || !claudeRecordBelongsToSource(source, record as Record<string, unknown>)) return null;
  return selectedText(record, locator.selector);
}

function isClaudeSessionSource(source: SessionSourceDescriptor): boolean {
  try {
    assertClaudeSessionSource(source);
    return true;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
