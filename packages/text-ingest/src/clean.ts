import { findFillers, findNearDuplicates, findRepeats, type CharSpan } from "./detectors.js";
import {
  byteOffsets,
  complement,
  resolveOverlaps,
  type ByteRange,
  type RemovalKind,
  type RemovedSpan,
} from "./spans.js";

export type { ByteRange, RemovalKind, RemovedSpan };

export interface CleanOptions {
  /** Byte ranges to drop, such as SponsorBlock segments the caller already mapped. */
  cutRanges?: readonly ByteRange[];
  /** Word-shingle Jaccard at or above which a paragraph repeating an earlier one is dropped. Off when unset. */
  nearDuplicateThreshold?: number;
}

export interface CleanResult {
  kept: ByteRange[];
  removed: RemovedSpan[];
}

function tagged(kind: RemovalKind, spans: readonly CharSpan[], offsets: Uint32Array): RemovedSpan[] {
  return spans.map((s) => ({ start: offsets[s.start]!, end: offsets[s.end]!, kind }));
}

/**
 * Cleans a transcript without rewriting it: the result lists byte ranges of `source` to keep and
 * the spans removed, so every surviving byte still points at its original position.
 */
export function cleanTranscript(source: string, options: CleanOptions = {}): CleanResult {
  const offsets = byteOffsets(source);
  const cuts = (options.cutRanges ?? []).map((r) => ({ ...r, kind: "sponsor-cut" as const }));
  const threshold = options.nearDuplicateThreshold;
  const duplicates = threshold === undefined ? [] : findNearDuplicates(source, threshold);
  const removed = resolveOverlaps([
    cuts,
    tagged("near-duplicate", duplicates, offsets),
    tagged("filler", findFillers(source), offsets),
    tagged("repeat", findRepeats(source), offsets),
  ]);
  return { kept: complement(removed, offsets[source.length]!), removed };
}
