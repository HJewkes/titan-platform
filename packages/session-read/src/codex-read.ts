import { readLocatorBytes } from "@titan-design/locator";
import { isStaleLine } from "./absent.js";
import { CodexRolloutDecoder } from "./codex-decoder.js";
import { CODEX_ROLLOUT_FORMAT, codexSourceFromPath } from "./codex-discover.js";
import type { NormalizedSessionObservation, ResumeBoundary, SessionSourceDescriptor, SourceTextLocator } from "./normalized.js";
import { hashLine, resolveSource, selectedText, streamObservations } from "./observation-stream.js";

export interface ReadCodexOptions {
  from?: ResumeBoundary;
  /** Test seam for ending after a complete line in a growing rollout. */
  untilByteOffset?: number;
}

export interface CodexReadResult {
  startByteOffset: number;
  resumeBoundary: ResumeBoundary;
  restartedFromZero: boolean;
}

export interface ReadCodexTextOptions {
  /** Fresh discovery results let a moved active/archive source resolve by sourceId. */
  sources?: readonly SessionSourceDescriptor[];
}

/** Prefix-replay reader with byte-hash rewrite detection and streaming observation delivery. */
export async function* readCodexObservations(
  source: SessionSourceDescriptor,
  options: ReadCodexOptions = {},
  onDone?: (result: CodexReadResult) => void,
): AsyncGenerator<NormalizedSessionObservation> {
  yield* streamObservations(source, new CodexRolloutDecoder(), options, onDone);
}

/** Read only the selected semantic subrecord, never the containing JSON line. */
export async function readCodexText(locator: SourceTextLocator, options: ReadCodexTextOptions = {}): Promise<string | null> {
  if (locator.source.format !== CODEX_ROLLOUT_FORMAT || locator.source.harness !== "codex") return null;
  const source = resolveSource(locator, options.sources);
  if (!source) return null;
  try {
    return (await sourceStillMatches(source)) ? await readSelectedText(source, locator) : null;
  } catch (error) {
    if (isStaleLine(error)) return null;
    throw error;
  }
}

async function readSelectedText(source: SessionSourceDescriptor, locator: SourceTextLocator): Promise<string | null> {
  const bytes = await readLocatorBytes(source.path, [0, locator.evidence.line.byteOffset, locator.evidence.line.byteLength]);
  const line = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (hashLine(line) !== locator.evidence.line.contentHash) return null;
  return selectedText(JSON.parse(line) as unknown, locator.selector);
}

async function sourceStillMatches(source: SessionSourceDescriptor): Promise<boolean> {
  const current = await codexSourceFromPath(source.path, source.namespace);
  return (
    current?.sourceId === source.sourceId &&
    current.conversation.harness === source.conversation.harness &&
    current.conversation.namespace === source.conversation.namespace &&
    current.conversation.nativeId === source.conversation.nativeId
  );
}
