import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { SourceLineEvidence } from "./normalized.js";
import type { RecentSessionReadError } from "./recent-types.js";

export interface RecentSourceLine {
  raw: string;
  evidence: SourceLineEvidence;
}

export type RecentTailRead =
  | {
      status: "read";
      lines: RecentSourceLine[];
      bytesRead: number;
      truncatedBefore: boolean;
      truncatedAfter: boolean;
      errors: RecentSessionReadError[];
    }
  | { status: "unavailable"; reason: string };

/** Read no more than maxBytes while retaining only newline-terminated records. */
export async function readRecentTail(sourceId: string, filePath: string, maxBytes: number): Promise<RecentTailRead> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, "r");
    const before = await handle.stat();
    const window = await readWindow(handle, before.size, maxBytes);
    const after = await handle.stat();
    return decodeWindow(sourceId, window, before.size, after.size);
  } catch (error) {
    return { status: "unavailable", reason: `could not read recent session source: ${messageOf(error)}` };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function readRecentTailSync(sourceId: string, filePath: string, maxBytes: number): RecentTailRead {
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(filePath, "r");
    const before = fstatSync(fileDescriptor);
    const window = readWindowSync(fileDescriptor, before.size, maxBytes);
    const after = fstatSync(fileDescriptor);
    return decodeWindow(sourceId, window, before.size, after.size);
  } catch (error) {
    return { status: "unavailable", reason: `could not read recent session source: ${messageOf(error)}` };
  } finally {
    if (fileDescriptor !== undefined) closeSafely(fileDescriptor);
  }
}

interface ByteWindow {
  bytes: Buffer;
  fileOffset: number;
  contentIndex: number;
  truncatedBefore: boolean;
}

async function readWindow(handle: FileHandle, size: number, maxBytes: number): Promise<ByteWindow> {
  const length = Math.min(size, maxBytes);
  const fileOffset = size - length;
  const bytes = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const read = await handle.read(bytes, filled, length - filled, fileOffset + filled);
    if (read.bytesRead === 0) break;
    filled += read.bytesRead;
  }
  const actual = bytes.subarray(0, filled);
  return byteWindow(actual, fileOffset, size > maxBytes);
}

function readWindowSync(fileDescriptor: number, size: number, maxBytes: number): ByteWindow {
  const length = Math.min(size, maxBytes);
  const fileOffset = size - length;
  const bytes = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const count = readSync(fileDescriptor, bytes, filled, length - filled, fileOffset + filled);
    if (count === 0) break;
    filled += count;
  }
  return byteWindow(bytes.subarray(0, filled), fileOffset, size > maxBytes);
}

function byteWindow(bytes: Buffer, fileOffset: number, truncatedBefore: boolean): ByteWindow {
  return {
    bytes,
    fileOffset,
    contentIndex: truncatedBefore ? alignedContentIndex(bytes) : 0,
    truncatedBefore,
  };
}

/** Byte zero is retained as the predecessor so an exact boundary is not skipped. */
function alignedContentIndex(bytes: Buffer): number {
  if (bytes.length < 2) return bytes.length;
  if (bytes[0] === 0x0a) return 1;
  const newline = bytes.indexOf(0x0a, 1);
  return newline < 0 ? bytes.length : newline + 1;
}

function decodeWindow(sourceId: string, window: ByteWindow, beforeSize: number, afterSize: number): RecentTailRead {
  const errors: RecentSessionReadError[] = [];
  const lines: RecentSourceLine[] = [];
  const finalNewline = window.bytes.lastIndexOf(0x0a);
  forEachCompleteLine(window, finalNewline, (bytes, byteOffset) => {
    const evidence = lineEvidence(sourceId, bytes, byteOffset);
    try {
      lines.push({ raw: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), evidence });
    } catch (error) {
      errors.push({ kind: "invalid_utf8", reason: messageOf(error), evidence });
    }
  });
  const incompleteEnd = finalNewline < window.bytes.length - 1;
  return {
    status: "read",
    lines,
    bytesRead: window.bytes.length,
    truncatedBefore: window.truncatedBefore,
    truncatedAfter: incompleteEnd || afterSize !== beforeSize,
    errors,
  };
}

function forEachCompleteLine(
  window: ByteWindow,
  finalNewline: number,
  visit: (bytes: Buffer, byteOffset: number) => void,
): void {
  if (finalNewline < window.contentIndex) return;
  let start = window.contentIndex;
  while (start <= finalNewline) {
    const end = window.bytes.indexOf(0x0a, start);
    if (end < 0 || end > finalNewline) return;
    if (end > start) visit(window.bytes.subarray(start, end), window.fileOffset + start);
    start = end + 1;
  }
}

function lineEvidence(sourceId: string, bytes: Buffer, byteOffset: number): SourceLineEvidence {
  return {
    sourceId,
    byteOffset,
    byteLength: bytes.length,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    lineNumber: null,
    nativeOrdinal: null,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closeSafely(fileDescriptor: number): void {
  try {
    closeSync(fileDescriptor);
  } catch {
    // The bounded read result remains valid when close reports a late error.
  }
}
