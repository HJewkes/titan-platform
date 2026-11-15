interface ByteRange {
    start: number;
    end: number;
}
type RemovalKind = "sponsor-cut" | "filler" | "repeat" | "near-duplicate";
interface RemovedSpan extends ByteRange {
    kind: RemovalKind;
}

interface CleanOptions {
    /** Byte ranges to drop, such as SponsorBlock segments the caller already mapped. */
    cutRanges?: readonly ByteRange[];
    /** Word-shingle Jaccard at or above which a paragraph repeating an earlier one is dropped. Off when unset. */
    nearDuplicateThreshold?: number;
}
interface CleanResult {
    kept: ByteRange[];
    removed: RemovedSpan[];
}
/**
 * Cleans a transcript without rewriting it: the result lists byte ranges of `source` to keep and
 * the spans removed, so every surviving byte still points at its original position.
 */
declare function cleanTranscript(source: string, options?: CleanOptions): CleanResult;

export { type ByteRange, type CleanOptions, type CleanResult, type RemovalKind, type RemovedSpan, cleanTranscript };
