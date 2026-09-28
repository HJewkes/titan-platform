export type SplitBoundary = "paragraph" | "newline" | "sentence" | "whitespace";

export interface SplitOptions {
  maxLength: number;
  /** Avoids a tiny trailing part. Defaults to a quarter of maxLength. */
  minLength?: number;
  /** Tried in order. Defaults to paragraph, newline, sentence, whitespace. */
  prefer?: readonly SplitBoundary[];
}

interface Fence {
  start: number;
  end: number;
  marker: string;
  opener: string;
}

const DEFAULT_PREFER: readonly SplitBoundary[] = ["paragraph", "newline", "sentence", "whitespace"];
const BOUNDARY_PATTERNS: Record<SplitBoundary, RegExp> = {
  paragraph: /\n\n/g,
  newline: /\n/g,
  sentence: /[.!?]\s/g,
  whitespace: /\s/g,
};
const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** Splits text into parts of at most `maxLength` UTF-16 units, preferring natural boundaries. */
export function splitText(text: string, options: SplitOptions): string[] {
  const { maxLength } = options;
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new RangeError(`maxLength must be a positive integer, got ${maxLength}`);
  }
  if (text.length <= maxLength) return text === "" ? [] : [text];
  const minLength = Math.max(1, options.minLength ?? Math.floor(maxLength / 4));
  const prefer = options.prefer ?? DEFAULT_PREFER;

  const parts: string[] = [];
  let rest = text;
  let carried: Fence | undefined;
  let midLine = false;
  for (;;) {
    const prefix = carried?.opener ?? "";
    if (prefix.length + rest.length <= maxLength) {
      parts.push(prefix + rest);
      return parts;
    }
    if (carried && maxLength - prefix.length <= closerLength(carried)) throw fenceRangeError();
    const fences = findFences(rest, carried, midLine);
    const at = chooseBreak(rest, fences, maxLength - prefix.length, minLength, prefer);
    const head = rest.slice(0, at);
    const fence = fences.find((f) => at > f.start && at < f.end);
    parts.push(prefix + head + (fence ? closerFor(head, fence) : ""));
    carried = fence;
    midLine = !head.endsWith("\n");
    rest = rest.slice(at);
  }
}

function fenceRangeError(): RangeError {
  return new RangeError("maxLength is too small to hold the fence lines plus one character");
}

function closerFor(head: string, fence: Fence): string {
  return head.endsWith("\n") ? fence.marker : `\n${fence.marker}`;
}

function closerLength(fence: Fence): number {
  return fence.marker.length + 1;
}

/** A fence line can only open or close at a real line start, so a mid-line remainder skips its first line. */
function findFences(text: string, carried: Fence | undefined, midLine: boolean): Fence[] {
  const fences: Fence[] = [];
  let open = carried && { ...carried, start: 0 };
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    const skip = midLine && lineStart === 0;
    const opening = open || skip ? undefined : openingFence(line, lineStart);
    if (opening) {
      open = opening;
    } else if (open && !skip && closesFence(line, open.marker)) {
      fences.push({ ...open, end: lineEnd });
      open = undefined;
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (open) fences.push({ ...open, end: text.length });
  return fences;
}

function openingFence(line: string, start: number): Fence | undefined {
  const match = OPEN_FENCE.exec(line);
  const marker = match?.[1];
  const info = match?.[2]?.trim() ?? "";
  if (!marker || (marker.startsWith("`") && info.includes("`"))) return undefined;
  return { start, end: 0, marker, opener: `${marker}${info}\n` };
}

/** CommonMark: same character as the opener, at least as long, nothing after it. */
function closesFence(line: string, marker: string): boolean {
  const run = CLOSE_FENCE.exec(line)?.[1];
  return run !== undefined && run.startsWith(marker[0] ?? "") && run.length >= marker.length;
}

function chooseBreak(
  rest: string,
  fences: readonly Fence[],
  room: number,
  minLength: number,
  prefer: readonly SplitBoundary[],
): number {
  const tailCap = rest.length - minLength;
  const limit = tailCap >= minLength ? Math.min(room, tailCap) : room;
  const fenceAt = (p: number) => fences.find((f) => p > f.start && p < f.end);
  const clean = lastBoundary(rest, limit, minLength, prefer, (p) => !fenceAt(p));
  // A break inside a fence must leave room for the closing line.
  const fits = (p: number) => {
    const fence = fenceAt(p);
    return !fence || p + closerLength(fence) <= limit;
  };
  const at = clean ?? lastBoundary(rest, limit, minLength, prefer, fits) ?? hardBreak(limit, fenceAt);
  return avoidSurrogateSplit(rest, at);
}

function hardBreak(limit: number, fenceAt: (p: number) => Fence | undefined): number {
  const fence = fenceAt(limit);
  if (!fence) return limit;
  const at = limit - closerLength(fence);
  if (at < 1) throw fenceRangeError();
  return at;
}

/** Tries each kind in order and returns the latest accepted break at or before `limit`. */
function lastBoundary(
  rest: string,
  limit: number,
  minLength: number,
  prefer: readonly SplitBoundary[],
  accept: (p: number) => boolean,
): number | undefined {
  const window = rest.slice(0, limit);
  for (const kind of prefer) {
    let best: number | undefined;
    for (const match of window.matchAll(BOUNDARY_PATTERNS[kind])) {
      const p = match.index + match[0].length;
      if (p >= minLength && accept(p)) best = p;
    }
    if (best !== undefined) return best;
  }
  return undefined;
}

function avoidSurrogateSplit(text: string, at: number): number {
  const splitsPair = isHighSurrogate(text.charCodeAt(at - 1)) && isLowSurrogate(text.charCodeAt(at));
  if (!splitsPair) return at;
  if (at < 2) throw new RangeError("maxLength is too small to hold one surrogate pair");
  return at - 1;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
