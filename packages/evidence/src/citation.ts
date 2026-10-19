import type { LineSource } from "./line-source.js";

/** A 1-based inclusive line range in one file. */
export interface LineRange {
  path: string;
  lineStart: number;
  lineEnd: number;
}

export interface Citation extends LineRange {
  quote: string;
}

/** The lines a reader was shown, per path. A citation outside them is rejected. */
export type ShownLines = ReadonlyMap<string, ReadonlySet<number>>;

export interface VerifyOptions {
  allowedPaths?: Iterable<string>;
  shown?: ShownLines;
}

export type CitationRejection =
  | "bad-range"
  | "path-not-allowed"
  | "path-unreadable"
  | "past-eof"
  | "not-shown"
  | "quote-empty"
  | "quote-mismatch";

export type CitationCheck =
  | { ok: true; citation: Citation }
  | { ok: false; citation: Citation; reason: CitationRejection; detail: string };

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

// Fragments shorter than this match almost anywhere, so they carry no evidence.
const MIN_FRAGMENT = 3;

/** Splits a quote on line breaks and "..." or "…" elisions into normalized, non-trivial fragments. */
export function quoteFragments(quote: string): string[] {
  return quote
    .split(/\n|\.\.\.|…/)
    .map(normalize)
    .filter((fragment) => fragment.length >= MIN_FRAGMENT);
}

/**
 * True when every quote fragment occurs in `text` after whitespace normalization, so a quote
 * re-wrapped over other line breaks still matches. Returns null when the quote has no fragment
 * long enough to check.
 */
export function quoteInText(text: string, quote: string): boolean | null {
  const fragments = quoteFragments(quote);
  if (fragments.length === 0) return null;
  const cited = normalize(text);
  return fragments.every((fragment) => cited.includes(fragment));
}

/** {@link quoteInText} over a 1-based inclusive range of a file's lines. */
export function quoteInRange(fileLines: readonly string[], range: Omit<LineRange, "path">, quote: string): boolean | null {
  return quoteInText(fileLines.slice(range.lineStart - 1, range.lineEnd).join("\n"), quote);
}

function reject(citation: Citation, reason: CitationRejection, detail: string): CitationCheck {
  return { ok: false, citation, reason, detail };
}

function unshownLine(citation: LineRange, shown: ShownLines): number | undefined {
  const lines = shown.get(citation.path);
  for (let line = citation.lineStart; line <= citation.lineEnd; line++) {
    if (!lines?.has(line)) return line;
  }
  return undefined;
}

export type RangeCheck = { ok: true; fileLines: readonly string[] } | { ok: false; reason: CitationRejection; detail: string };

/** Checks a range's shape, path, end-of-file and visibility, with no quote; the first failure wins. */
export function verifyRange(source: LineSource, range: LineRange, options: VerifyOptions = {}): RangeCheck {
  const { path, lineStart, lineEnd } = range;
  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || lineStart < 1 || lineEnd < lineStart) {
    return { ok: false, reason: "bad-range", detail: `bad range ${lineStart}-${lineEnd}` };
  }
  if (options.allowedPaths && !new Set(options.allowedPaths).has(path)) {
    return { ok: false, reason: "path-not-allowed", detail: `${path} is not among the allowed paths` };
  }
  const fileLines = source.lines(path);
  if (!fileLines) return { ok: false, reason: "path-unreadable", detail: `${path} could not be read` };
  if (lineEnd > fileLines.length) {
    return { ok: false, reason: "past-eof", detail: `range ends at ${lineEnd} but ${path} has ${fileLines.length} lines` };
  }
  const hidden = options.shown && unshownLine(range, options.shown);
  if (hidden !== undefined) return { ok: false, reason: "not-shown", detail: `${path}:${hidden} was not shown` };
  return { ok: true, fileLines };
}

/** Checks a citation's path, range, visibility and quote. Rejections carry a machine-readable reason. */
export function verifyCitation(source: LineSource, citation: Citation, options: VerifyOptions = {}): CitationCheck {
  const located = verifyRange(source, citation, options);
  if (!located.ok) return reject(citation, located.reason, located.detail);
  const found = quoteInRange(located.fileLines, citation, citation.quote);
  if (found === null) return reject(citation, "quote-empty", "quote has no fragment of 3 or more characters");
  if (!found) return reject(citation, "quote-mismatch", `quote not found in ${citation.path}:${citation.lineStart}-${citation.lineEnd}`);
  return { ok: true, citation };
}
