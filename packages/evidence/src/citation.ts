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
 * True when every quote fragment occurs in the cited lines after whitespace normalization.
 * Returns null when the quote has no fragment long enough to check.
 */
export function quoteInRange(fileLines: readonly string[], range: Omit<LineRange, "path">, quote: string): boolean | null {
  const fragments = quoteFragments(quote);
  if (fragments.length === 0) return null;
  const cited = normalize(fileLines.slice(range.lineStart - 1, range.lineEnd).join("\n"));
  return fragments.every((fragment) => cited.includes(fragment));
}

function reject(citation: Citation, reason: CitationRejection, detail: string): CitationCheck {
  return { ok: false, citation, reason, detail };
}

function unshownLine(citation: Citation, shown: ShownLines): number | undefined {
  const lines = shown.get(citation.path);
  for (let line = citation.lineStart; line <= citation.lineEnd; line++) {
    if (!lines?.has(line)) return line;
  }
  return undefined;
}

function checkLocation(citation: Citation, source: LineSource, options: VerifyOptions): CitationCheck | { fileLines: readonly string[] } {
  const { path, lineStart, lineEnd } = citation;
  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || lineStart < 1 || lineEnd < lineStart) {
    return reject(citation, "bad-range", `bad range ${lineStart}-${lineEnd}`);
  }
  if (options.allowedPaths && !new Set(options.allowedPaths).has(path)) {
    return reject(citation, "path-not-allowed", `${path} is not among the allowed paths`);
  }
  const fileLines = source.lines(path);
  if (!fileLines) return reject(citation, "path-unreadable", `${path} could not be read`);
  if (lineEnd > fileLines.length) {
    return reject(citation, "past-eof", `range ends at ${lineEnd} but ${path} has ${fileLines.length} lines`);
  }
  const hidden = options.shown && unshownLine(citation, options.shown);
  if (hidden !== undefined) return reject(citation, "not-shown", `${path}:${hidden} was not shown`);
  return { fileLines };
}

/** Checks a citation's path, range, visibility and quote. Rejections carry a machine-readable reason. */
export function verifyCitation(source: LineSource, citation: Citation, options: VerifyOptions = {}): CitationCheck {
  const located = checkLocation(citation, source, options);
  if (!("fileLines" in located)) return located;
  const found = quoteInRange(located.fileLines, citation, citation.quote);
  if (found === null) return reject(citation, "quote-empty", "quote has no fragment of 3 or more characters");
  if (!found) return reject(citation, "quote-mismatch", `quote not found in ${citation.path}:${citation.lineStart}-${citation.lineEnd}`);
  return { ok: true, citation };
}
