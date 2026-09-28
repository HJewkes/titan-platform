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
  opener: string;
}

const DEFAULT_PREFER: readonly SplitBoundary[] = ["paragraph", "newline", "sentence", "whitespace"];
const BOUNDARY_PATTERNS: Record<SplitBoundary, RegExp> = {
  paragraph: /\n\n/g,
  newline: /\n/g,
  sentence: /[.!?]\s/g,
  whitespace: /\s/g,
};
const OPEN_FENCE = /^ {0,3}```([^`]*)$/;
const CLOSE_FENCE = /^ {0,3}```\s*$/;
const CLOSER_LENGTH = "\n```".length;

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
  let carried: string | undefined;
  for (;;) {
    const prefix = carried ?? "";
    if (prefix.length + rest.length <= maxLength) {
      parts.push(prefix + rest);
      return parts;
    }
    if (carried !== undefined && maxLength - prefix.length <= CLOSER_LENGTH) throw fenceRangeError();
    const fences = findFences(rest, carried);
    const at = chooseBreak(rest, fences, maxLength - prefix.length, minLength, prefer);
    const head = rest.slice(0, at);
    const fence = fences.find((f) => at > f.start && at < f.end);
    parts.push(prefix + head + (fence ? closerFor(head) : ""));
    carried = fence?.opener;
    rest = rest.slice(at);
  }
}

function fenceRangeError(): RangeError {
  return new RangeError("maxLength is too small to hold the fence lines plus one character");
}

function closerFor(head: string): string {
  return head.endsWith("\n") ? "```" : "\n```";
}

function findFences(text: string, carried: string | undefined): Fence[] {
  const fences: Fence[] = [];
  let open: { start: number; opener: string } | undefined =
    carried === undefined ? undefined : { start: 0, opener: carried };
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    const opening = open ? null : OPEN_FENCE.exec(line);
    if (opening) {
      open = { start: lineStart, opener: `\`\`\`${opening[1]?.trim() ?? ""}\n` };
    } else if (open && CLOSE_FENCE.test(line) && lineStart > open.start) {
      fences.push({ ...open, end: lineEnd });
      open = undefined;
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (open) fences.push({ ...open, end: text.length });
  return fences;
}

function chooseBreak(
  rest: string,
  fences: readonly Fence[],
  room: number,
  minLength: number,
  prefer: readonly SplitBoundary[],
): number {
  const insideFence = (p: number) => fences.some((f) => p > f.start && p < f.end);
  const tailCap = rest.length - minLength;
  const limit = tailCap >= minLength ? Math.min(room, tailCap) : room;
  const clean = lastBoundary(rest, limit, minLength, prefer, (p) => !insideFence(p));
  const at = clean ?? fallbackBreak(rest, limit, minLength, prefer, insideFence);
  return avoidSurrogateSplit(rest, at);
}

function fallbackBreak(
  rest: string,
  limit: number,
  minLength: number,
  prefer: readonly SplitBoundary[],
  insideFence: (p: number) => boolean,
): number {
  if (!insideFence(limit)) return limit;
  const room = limit - CLOSER_LENGTH;
  if (room < 1) throw fenceRangeError();
  return lastBoundary(rest, room, minLength, prefer, () => true) ?? room;
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
