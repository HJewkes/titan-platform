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
 */
export async function resumePoint(
  entry: TranscriptEntry,
  absolutePath: string,
  options: { verifyHash?: boolean } = {},
): Promise<ResumePoint> {
  let size: number;
  try {
    size = (await fs.stat(absolutePath)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing", start: 0, size: 0 };
    throw err;
  }
  let rewritten = size < entry.lastByteOffset;
  if (!rewritten && options.verifyHash && entry.prefixHash !== null) {
    rewritten = (await prefixHash(absolutePath, entry.lastByteOffset)) !== entry.prefixHash;
  }
  if (rewritten) return { state: "rewritten", start: 0, size };
  const state = size > entry.lastByteOffset ? "appended" : "unchanged";
  return { state, start: entry.lastByteOffset, size };
}
