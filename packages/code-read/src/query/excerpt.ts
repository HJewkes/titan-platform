import { EXCERPT_LINE_CAP, type SourceExcerpt } from "./contract-findings.js";
import type { Span } from "./schemas.js";
import type { SourceRead, SourceWindow } from "./source.js";

export interface ExcerptResult {
  excerpt: SourceExcerpt | null;
  missing?: string;
}

interface Window {
  from: number;
  to: number;
  truncated: boolean;
}

/** The flagged lines plus `context` either side, clipped to the file; a whole-node finding starts at line 1. */
export function excerptWindow(ranges: readonly Span[], context: number, lineCount: number): Window {
  const from = ranges.length === 0 ? 1 : Math.max(1, Math.min(...ranges.map((r) => r.startLine)) - context);
  const wanted = ranges.length === 0 ? lineCount : Math.min(lineCount, Math.max(...ranges.map((r) => r.endLine)) + context);
  const to = Math.min(wanted, from + EXCERPT_LINE_CAP - 1);
  return { from, to, truncated: to < wanted };
}

function clipped(ranges: readonly Span[], from: number, to: number): Span[] {
  return ranges
    .filter((r) => r.endLine >= from && r.startLine <= to)
    .map((r) => ({ startLine: Math.max(r.startLine, from), endLine: Math.min(r.endLine, to) }));
}

function holds(window: SourceWindow, from: number, to: number): boolean {
  return from >= window.startLine && to <= window.startLine + window.lines.length - 1;
}

/** Cut an excerpt from what the source returned; a static window that misses the range says "not-in-export". */
export function buildExcerpt(read: SourceRead, ranges: readonly Span[], context: number): ExcerptResult {
  if ("unavailable" in read) return { excerpt: null, missing: read.unavailable };
  const { from, to, truncated } = excerptWindow(ranges, context, read.lineCount);
  if (to >= from && !holds(read, from, to)) return { excerpt: null, missing: "not-in-export" };
  const text = read.lines.slice(from - read.startLine, to - read.startLine + 1).join("\n");
  const excerpt: SourceExcerpt = {
    path: read.path,
    startLine: from,
    endLine: to,
    text,
    contentHash: read.contentHash,
    origin: read.origin,
    highlights: clipped(ranges, from, to),
    truncated,
  };
  return { excerpt };
}
