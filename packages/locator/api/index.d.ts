/**
 * A pointer into a transcript: `[transcriptIndex, byteOffset, byteLength]`.
 * The index names a row in a transcript table; the offset and length address
 * exact bytes in that file. Never the text itself.
 */
type Locator = readonly [transcriptIndex: number, byteOffset: number, byteLength: number];
declare function isLocator(value: unknown): value is Locator;
/** `t:offset:length`, the compact form for URLs, log lines, and CLI args. */
declare function formatLocator([index, offset, length]: Locator): string;
declare function parseLocator(text: string): Locator;

interface RawLine {
    /** Absolute byte offset of the line's first byte within the file. */
    byteOffset: number;
    /** Byte length of the line, excluding its terminating newline. */
    byteLength: number;
    text: string;
}
/**
 * Stream complete newline-terminated lines from `startOffset` with exact byte
 * offsets. The buffer is split by hand rather than via `readline`, which hides
 * the terminator and normalizes `\r\n`, so a byte cursor derived from its
 * output drifts on any file that is not pure LF.
 *
 * A trailing partial line (a file being appended to right now) is withheld so a
 * watermark advanced to `byteOffset + byteLength + 1` never lands mid-record.
 * `startOffset` must therefore be a line boundary.
 */
declare function readJsonLines(filePath: string, startOffset?: number, options?: {
    strictUtf8?: boolean;
}): AsyncGenerator<RawLine>;
/** The watermark a reader should store after consuming `line`: the byte after its newline. */
declare function nextOffset(line: RawLine): number;

/**
 * sha256 over bytes `[0, byteLength)` of `filePath`. Transcripts are append-only
 * in normal operation, so a stored prefix hash that still matches means the
 * already-indexed bytes are untouched and a reader can resume at its watermark.
 */
declare function prefixHash(filePath: string, byteLength: number): Promise<string>;
/** sha256 of the whole file, the content address a raw mirror is stored under. */
declare function contentHash(filePath: string): Promise<string>;

/**
 * One row of the transcript table. `transcripts[i]` defines what
 * `transcriptIndex === i` means in every locator, so rows are only ever
 * appended, never reordered or removed.
 */
interface TranscriptEntry {
    path: string;
    lastByteOffset: number;
    /** sha256 of bytes `[0, lastByteOffset)`, or null when never verified. */
    prefixHash: string | null;
    /** The file's mtime when it was last read, ISO-8601. Enables the cheap rewrite check below. */
    mtime?: string | null;
}
interface TranscriptTable {
    transcripts: TranscriptEntry[];
}
declare function emptyTable(): TranscriptTable;
/** The index for `path`, appending a fresh row on first sight. Stable for the table's life. */
declare function transcriptIndexFor(table: TranscriptTable, path: string): number;
type TranscriptState = "unchanged" | "appended" | "rewritten" | "missing";
interface ResumePoint {
    state: TranscriptState;
    /** Byte offset to resume reading from: the watermark, or 0 after a rewrite. */
    start: number;
    size: number;
}
/**
 * Where to resume in the file behind `entry`. A file shorter than its watermark
 * was rewritten or truncated, so every stored offset past that point is
 * meaningless and the only correct answer is byte 0. `verifyHash` extends the
 * same check to a same-length rewrite at the cost of re-reading the prefix.
 *
 * Transcripts only ever grow, so a file that is exactly as long as its watermark
 * yet carries a newer mtime was rewritten in place — the one rotation a size
 * comparison cannot see. That case hashes without being asked to, because the
 * cost lands on the handful of files that look wrong rather than on every file
 * on every pass, which is what makes `verifyHash` too expensive to leave on.
 */
declare function resumePoint(entry: TranscriptEntry, absolutePath: string, options?: {
    verifyHash?: boolean;
}): Promise<ResumePoint>;

/** The exact bytes a locator addresses. Throws if the file is now shorter than the span. */
declare function readLocatorBytes(absolutePath: string, [, byteOffset, byteLength]: Locator): Promise<Buffer>;
declare function readLocatorText(absolutePath: string, locator: Locator): Promise<string>;

interface MirrorRecord {
    hash: string;
    /** Absolute path of the content-addressed copy. */
    mirrorPath: string;
    /** False when an identical copy already existed. */
    copied: boolean;
}
declare function mirrorPathFor(mirrorDir: string, hash: string): string;
/**
 * Keep a content-addressed copy of a transcript so locators stay resolvable
 * after the source is rotated or deleted. Idempotent: the same bytes land on
 * the same path, and a second call copies nothing.
 */
declare function mirrorFile(sourcePath: string, mirrorDir: string): Promise<MirrorRecord>;
/** The source if it still exists, else the mirror for `hash`, else null. */
declare function resolveSource(sourcePath: string, mirrorDir: string, hash: string | null): Promise<string | null>;

/**
 * Write to a sibling temp file, fsync, then rename over the target. The temp
 * file lives in the same directory so the rename stays on one filesystem,
 * which is what makes it atomic on POSIX.
 */
declare function atomicWrite(targetPath: string, content: string | Buffer): Promise<void>;

export { type Locator, type MirrorRecord, type RawLine, type ResumePoint, type TranscriptEntry, type TranscriptState, type TranscriptTable, atomicWrite, contentHash, emptyTable, formatLocator, isLocator, mirrorFile, mirrorPathFor, nextOffset, parseLocator, prefixHash, readJsonLines, readLocatorBytes, readLocatorText, resolveSource, resumePoint, transcriptIndexFor };
