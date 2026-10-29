import { promptLine } from "@titan-design/owner-queue";

/** One changed `.github/` file read at the base and at the head; an absent side is the empty string. */
export interface CiPolicyFile {
  path: string;
  before: string;
  after: string;
}

/** One changed line: `-` removed from the base, `+` added at the head, `n` its 1-based line number on that side. */
interface CiPolicyLine {
  side: "-" | "+";
  n: number;
  text: string;
}

/** Every changed line of one file in diff order, up to the caps; `omitted` counts the rest, so shown + omitted = removed + added. */
export interface CiPolicyFileChange {
  path: string;
  lines: CiPolicyLine[];
  omitted: number;
}

export const MAX_LINES_PER_FILE = 20;
export const MAX_LINES_PER_CARD = 120;
export const MAX_LINE_CHARS = 160;

/** Opens each unread fact of a D21 file read, so the card can name those files beside the lines it did read. */
export const CI_POLICY_UNREAD_PREFIX = "the CI-policy lines of ";

/** A viewer may render NEL and the line and paragraph separators as breaks, but YAML does not, so they stay in the line as a visible mark and line numbers still match. */
const SEPARATOR_MARK = "\u{23ce}";
/** JSON escapes a lone surrogate as six characters, which would break the evidence comment's size bound. */
const LONE_SURROGATE = /[\u{d800}-\u{dfff}]/gu;

/** YAML breaks a line at CR, LF or CRLF only, so a bare CR splits instead of joining two lines into one. */
const LINE_BREAK = /\r\n|\r|\n/;

/** Above this many table cells the changed middle of a file reads as wholly changed, which shows more lines, never fewer. */
const MAX_DIFF_CELLS = 4_000_000;

/** Every line is author-written and reaches the owner's prompt. Runs after the split, so stripping can never join two lines. */
const cleanLine = (line: string): string => promptLine(line.replace(/\t/g, "  "), { lineBreak: SEPARATOR_MARK }).trimEnd();

/** Strips escapes and control characters, keeps the indent that shows YAML nesting, and cuts at `MAX_LINE_CHARS` with an ellipsis. */
export function shownLine(line: string): string {
  const flat = cleanLine(line);
  const cut = flat.length <= MAX_LINE_CHARS ? flat : `${flat.slice(0, MAX_LINE_CHARS - 1)}…`;
  return cut.replace(LONE_SURROGATE, "\u{fffd}");
}

/** The raw lines, so a change only in characters the card strips still shows as a changed line; a final break ends the last line. */
export function linesOf(text: string): string[] {
  const lines = text.split(LINE_BREAK);
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

interface Edit {
  side: "-" | "+";
  index: number;
}

const range = (side: Edit["side"], from: number, to: number): Edit[] => Array.from({ length: Math.max(0, to - from) }, (_, offset) => ({ side, index: from + offset }));

/**
 * A positional diff of whole files in diff order: the common prefix and suffix, then a longest-common-subsequence over
 * the rest, so a swapped, moved or repeated line still shows. Set membership would cancel a `read` and a `write` that trade places.
 */
function lineEdits(a: readonly string[], b: readonly string[]): Edit[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) [endA, endB] = [endA - 1, endB - 1];
  if ((endA - start + 1) * (endB - start + 1) > MAX_DIFF_CELLS) return [...range("-", start, endA), ...range("+", start, endB)];
  return lcsEdits(a.slice(start, endA), b.slice(start, endB)).map((edit) => ({ ...edit, index: edit.index + start }));
}

function lcsEdits(a: readonly string[], b: readonly string[]): Edit[] {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  const at = (i: number, j: number): number => table[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) table[i * width + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  }
  const edits: Edit[] = [];
  let [i, j] = [0, 0];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) [i, j] = [i + 1, j + 1];
    else if (j >= b.length || (i < a.length && at(i + 1, j) >= at(i, j + 1))) edits.push({ side: "-", index: (i += 1) - 1 });
    else edits.push({ side: "+", index: (j += 1) - 1 });
  }
  return edits;
}

/**
 * Every changed line of each file's positional diff, in diff order, with no filter on what a line says: a line is shown
 * or counted in `omitted`. The first lines in diff order fill 20 per file and 120 across files.
 */
export function ciPolicyChanges(files: readonly CiPolicyFile[]): CiPolicyFileChange[] {
  let cardLeft = MAX_LINES_PER_CARD;
  return files.map((file) => {
    const sides = { "-": linesOf(file.before), "+": linesOf(file.after) };
    const edits = lineEdits(sides["-"], sides["+"]);
    const shown = edits.slice(0, Math.min(MAX_LINES_PER_FILE, cardLeft));
    cardLeft -= shown.length;
    const lines = shown.map(({ side, index }) => ({ side, n: index + 1, text: shownLine(sides[side][index] ?? "") }));
    return { path: shownLine(file.path), lines, omitted: edits.length - shown.length };
  });
}
