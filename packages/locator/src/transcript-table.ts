import { promises as fs } from "node:fs";
import { prefixHash } from "./hash.js";

/**
 * One row of the transcript table. `transcripts[i]` defines what
 * `transcriptIndex === i` means in every locator, so rows are only ever
 * appended, never reordered or removed.
 */
export interface TranscriptEntry {
  path: string;
  lastByteOffset: number;
  /** sha256 of bytes `[0, lastByteOffset)`, or null when never verified. */
  prefixHash: string | null;
  /** The file's mtime when it was last read, ISO-8601. Enables the cheap rewrite check below. */
  mtime?: string | null;
}

export interface TranscriptTable {
  transcripts: TranscriptEntry[];
}

export function emptyTable(): TranscriptTable {
  return { transcripts: [] };
}

/** The index for `path`, appending a fresh row on first sight. Stable for the table's life. */
export function transcriptIndexFor(table: TranscriptTable, path: string): number {
  const existing = table.transcripts.findIndex((t) => t.path === path);
  if (existing !== -1) return existing;
  table.transcripts.push({ path, lastByteOffset: 0, prefixHash: null });
  return table.transcripts.length - 1;
}

export type TranscriptState = "unchanged" | "appended" | "rewritten" | "missing";

export interface ResumePoint {
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
export async function resumePoint(
  entry: TranscriptEntry,
  absolutePath: string,
  options: { verifyHash?: boolean } = {},
): Promise<ResumePoint> {
  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing", start: 0, size: 0 };
    throw err;
  }
  const size = stat.size;
  let rewritten = size < entry.lastByteOffset;
  if (!rewritten && entry.prefixHash !== null && (options.verifyHash || touchedInPlace(entry, stat.mtime, size))) {
    rewritten = (await prefixHash(absolutePath, entry.lastByteOffset)) !== entry.prefixHash;
  }
  if (rewritten) return { state: "rewritten", start: 0, size };
  const state = size > entry.lastByteOffset ? "appended" : "unchanged";
  return { state, start: entry.lastByteOffset, size };
}

/** Same length as when we last read it, but written to since. Unknown mtime means no signal. */
function touchedInPlace(entry: TranscriptEntry, mtime: Date, size: number): boolean {
  if (entry.mtime == null || size !== entry.lastByteOffset) return false;
  return mtime.toISOString() !== entry.mtime;
}
