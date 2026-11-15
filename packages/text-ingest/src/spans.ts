export interface ByteRange {
  start: number;
  end: number;
}

export type RemovalKind = "sponsor-cut" | "filler" | "repeat" | "near-duplicate";

export interface RemovedSpan extends ByteRange {
  kind: RemovalKind;
}

/** Maps each UTF-16 index of `text` to its byte offset in the UTF-8 encoding. */
export function byteOffsets(text: string): Uint32Array {
  const offsets = new Uint32Array(text.length + 1);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    let width = 3;
    if (code < 0x80) width = 1;
    else if (code < 0x800) width = 2;
    else if (code >= 0xd800 && code < 0xdc00) width = 4;
    else if (code >= 0xdc00 && code < 0xe000) width = 0;
    offsets[i + 1] = offsets[i]! + width;
  }
  return offsets;
}

/** Pieces of `range` not covered by any range in `covered` (sorted, disjoint). */
function uncovered(range: ByteRange, covered: readonly ByteRange[]): ByteRange[] {
  const pieces: ByteRange[] = [];
  let cursor = range.start;
  for (const hole of covered) {
    if (hole.end <= cursor) continue;
    if (hole.start >= range.end) break;
    if (hole.start > cursor) pieces.push({ start: cursor, end: hole.start });
    cursor = Math.max(cursor, hole.end);
  }
  if (cursor < range.end) pieces.push({ start: cursor, end: range.end });
  return pieces;
}

function insertSorted(covered: ByteRange[], range: ByteRange): void {
  const at = covered.findIndex((r) => r.start > range.start);
  covered.splice(at === -1 ? covered.length : at, 0, range);
}

/** Resolves overlaps: earlier groups win, later spans keep only what is left. */
export function resolveOverlaps(groups: readonly (readonly RemovedSpan[])[]): RemovedSpan[] {
  const covered: ByteRange[] = [];
  const resolved: RemovedSpan[] = [];
  for (const group of groups) {
    for (const span of group) {
      for (const piece of uncovered(span, covered)) {
        resolved.push({ ...piece, kind: span.kind });
        insertSorted(covered, piece);
      }
    }
  }
  return resolved.sort((a, b) => a.start - b.start);
}

export function complement(removed: readonly ByteRange[], length: number): ByteRange[] {
  const kept: ByteRange[] = [];
  let cursor = 0;
  for (const span of removed) {
    if (span.start > cursor) kept.push({ start: cursor, end: span.start });
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < length) kept.push({ start: cursor, end: length });
  return kept;
}
