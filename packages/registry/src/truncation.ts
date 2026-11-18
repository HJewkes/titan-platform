export interface TruncateOptions {
  /** Hard ceiling on the UTF-8 byte length of the returned text. */
  maxBytes: number;
  /** Share of the kept lines taken from the start of the input. Defaults to 0.6. */
  headRatio?: number;
  /** Replaces the default omission marker, in both line and character mode. */
  separator?: string;
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
  originalLines: number;
  /** Lines none of whose characters, terminating newline included, reach the output. */
  omittedLines: number;
}

/** Marker for the character-level fallback, where no whole-line cut fits the budget. */
const CHARACTER_TRUNCATION_MARKER = "\n--- truncated ---\n";

const DEFAULT_HEAD_RATIO = 0.6;

/**
 * Cuts tool output to a byte budget, keeping the head and tail of the input.
 * Prefers whole lines with a `--- N lines omitted ---` marker; when not even the
 * first and last line fit, it cuts at code point boundaries instead.
 */
export function truncateOutput(input: string, options: TruncateOptions): TruncateResult {
  const { maxBytes, headRatio = DEFAULT_HEAD_RATIO, separator } = options;
  assertOptions(maxBytes, headRatio);
  const lines = input.split("\n");
  if (utf8Length(input) <= maxBytes) {
    return { text: input, truncated: false, originalLines: lines.length, omittedLines: 0 };
  }
  return (
    truncateLines(lines, maxBytes, headRatio, separator) ??
    truncateCharacters(input, lines.length, maxBytes, headRatio, separator ?? CHARACTER_TRUNCATION_MARKER)
  );
}

function assertOptions(maxBytes: number, headRatio: number): void {
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative integer, got ${maxBytes}`);
  }
  if (!(headRatio >= 0 && headRatio <= 1)) {
    throw new RangeError(`headRatio must be between 0 and 1, got ${headRatio}`);
  }
}

/** Keeps the most lines that fit, scanning down from all-but-one so at least one line is omitted. */
function truncateLines(
  lines: string[],
  maxBytes: number,
  headRatio: number,
  separator: string | undefined,
): TruncateResult | undefined {
  const total = lines.length;
  const prefix = prefixByteSums(lines);
  const spanBytes = (from: number, to: number) => prefix[to]! - prefix[from]! + (to - from - 1);
  for (let kept = total - 1; kept >= 2; kept--) {
    const head = Math.min(kept - 1, Math.max(1, Math.round(kept * headRatio)));
    const tail = kept - head;
    const omittedLines = total - kept;
    const marker = separator ?? `\n--- ${omittedLines} ${omittedLines === 1 ? "line" : "lines"} omitted ---\n`;
    if (spanBytes(0, head) + utf8Length(marker) + spanBytes(total - tail, total) <= maxBytes) {
      const text = lines.slice(0, head).join("\n") + marker + lines.slice(total - tail).join("\n");
      return { text, truncated: true, originalLines: total, omittedLines };
    }
  }
  return undefined;
}

function prefixByteSums(lines: string[]): number[] {
  const sums = [0];
  for (const line of lines) sums.push(sums[sums.length - 1]! + utf8Length(line));
  return sums;
}

function truncateCharacters(
  input: string,
  originalLines: number,
  maxBytes: number,
  headRatio: number,
  marker: string,
): TruncateResult {
  const markerBytes = utf8Length(marker);
  if (markerBytes > maxBytes) {
    const head = prefixWithin(input, maxBytes);
    return charResult(input, head, input.length, originalLines, head);
  }
  const available = maxBytes - markerBytes;
  const headBytes = Math.floor(available * headRatio);
  const head = prefixWithin(input, headBytes);
  const tailStart = suffixStartWithin(input, available - utf8Length(head), head.length);
  return charResult(input, head, tailStart, originalLines, head + marker + input.slice(tailStart));
}

function charResult(
  input: string,
  head: string,
  tailStart: number,
  originalLines: number,
  text: string,
): TruncateResult {
  const omittedLines = originalLines - keptLineCount(input, head.length, tailStart, originalLines);
  return { text, truncated: true, originalLines, omittedLines };
}

/** Counts lines with at least one character, their newline included, in [0, headEnd) or [tailStart, end). */
function keptLineCount(input: string, headEnd: number, tailStart: number, totalLines: number): number {
  const headLast = headEnd > 0 ? newlinesBefore(input, headEnd - 1) : -1;
  const tailFirst = tailStart < input.length ? newlinesBefore(input, tailStart) : totalLines;
  const fromHead = headLast + 1;
  const fromTail = totalLines - tailFirst;
  return fromHead + fromTail - Math.max(0, headLast - tailFirst + 1);
}

function newlinesBefore(input: string, end: number): number {
  let count = 0;
  for (let i = input.indexOf("\n"); i !== -1 && i < end; i = input.indexOf("\n", i + 1)) count++;
  return count;
}

function prefixWithin(input: string, budget: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of input) {
    bytes += codePointBytes(char.codePointAt(0)!);
    if (bytes > budget) break;
    end += char.length;
  }
  return input.slice(0, end);
}

/** Start index of the longest suffix within budget that begins at or after `floor`. */
function suffixStartWithin(input: string, budget: number, floor: number): number {
  let bytes = 0;
  let start = input.length;
  while (start > floor) {
    const step = endsWithSurrogatePair(input, start, floor) ? 2 : 1;
    bytes += codePointBytes(input.codePointAt(start - step)!);
    if (bytes > budget) break;
    start -= step;
  }
  return start;
}

function endsWithSurrogatePair(input: string, end: number, floor: number): boolean {
  if (end - 2 < floor) return false;
  const high = input.charCodeAt(end - 2);
  const low = input.charCodeAt(end - 1);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/** UTF-8 length as Node's Buffer.byteLength counts it: a lone surrogate encodes as U+FFFD (3 bytes). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) bytes += codePointBytes(char.codePointAt(0)!);
  return bytes;
}

function codePointBytes(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  return codePoint < 0x10000 ? 3 : 4;
}
