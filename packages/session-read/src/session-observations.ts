import { readClaudeObservations, readClaudeText } from "./claude-read.js";
import { CLAUDE_TRANSCRIPT_FORMAT } from "./claude-source.js";
import { readCodexObservations, readCodexText } from "./codex-read.js";
import { CODEX_ROLLOUT_FORMAT } from "./codex-discover.js";
import type { NormalizedSessionObservation, ResumeBoundary, SessionSourceDescriptor, SourceTextLocator } from "./normalized.js";

export interface ReadSessionObservationOptions {
  from?: ResumeBoundary;
  /** Test seam for ending after a complete line in a growing source. */
  untilByteOffset?: number;
}

export interface SessionObservationReadResult {
  startByteOffset: number;
  resumeBoundary: ResumeBoundary;
  restartedFromZero: boolean;
}

export interface ReadSessionSourceTextOptions {
  /** Fresh discovery results used to resolve a source whose path moved. */
  sources?: readonly SessionSourceDescriptor[];
}

/** Dispatch authoritative normalized observation reads by explicit source format and harness. */
export async function* readSessionObservations(
  source: SessionSourceDescriptor,
  options: ReadSessionObservationOptions = {},
  onDone?: (result: SessionObservationReadResult) => void,
): AsyncGenerator<NormalizedSessionObservation> {
  if (source.harness === "claude-code" && source.format === CLAUDE_TRANSCRIPT_FORMAT) {
    yield* readClaudeObservations(source, options, onDone);
    return;
  }
  if (source.harness === "codex" && source.format === CODEX_ROLLOUT_FORMAT) {
    yield* readCodexObservations(source, options, onDone);
    return;
  }
  throw new TypeError(`unsupported session source format ${source.harness}/${source.format}`);
}

/** Read selected semantic text through the format named by a locator snapshot. */
export async function readSessionSourceText(
  locator: SourceTextLocator,
  options: ReadSessionSourceTextOptions = {},
): Promise<string | null> {
  if (locator.source.harness === "claude-code" && locator.source.format === CLAUDE_TRANSCRIPT_FORMAT) {
    return readClaudeText(locator, options);
  }
  if (locator.source.harness === "codex" && locator.source.format === CODEX_ROLLOUT_FORMAT) {
    return readCodexText(locator, options);
  }
  return null;
}
