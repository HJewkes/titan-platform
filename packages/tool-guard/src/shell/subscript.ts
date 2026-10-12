import { dollarOpener } from "./balanced.js";
import { joinedDollar, joinedWithIndex, readAhead } from "./joins.js";
import type { Token, WordToken } from "./lexer.js";

const ASSIGNMENT_WORD_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[.*\])?\+?=/s;
/** `(` is left out: inside a case pattern it opens no command, and a subshell then splits as on main. */
const CONTROL_OPERATORS = new Set([";", "&", "&&", "||", "|", "|&", "\n"]);
const PIPES = new Set(["|", "|&"]);
const COMMAND_STARTS = new Set(["{", "then", "do", "else", "elif", "if", "while", "until", "!"]);
/**
 * Case statements, `[[ ]]`, `(( ))`, `$(( ))`, here-docs and extglob patterns such as `@(a|b)` hold operators and
 * newlines that start no command, so no token position can say where an assignment stands. Any of them before the
 * `[`, quoted or not, refuses the join. Bash lexes left to right, so one after it cannot move the `[` and leaves
 * the join alone. The split reading stays for such a `[`, but `ambiguousSubscriptEnd` keeps its body from hiding text.
 */
const UNPLACEABLE_RE = /\b(?:case|esac)\b|\[\[|\]\]|\(\(|\)\)|<<|[?*+@!]\(/g;
const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_]/;

const UNSURE = -2;

/**
 * Bash reads `NAME[...]` through the matching `]` as one word, blanks included, when it stands where an
 * assignment may and `=` or `+=` follows: `Y[ 0 ]=x git push` assigns element 0 and runs git.
 * Returns the index of that `]` for the `[` at `open`, or -1 when the word lexes as usual.
 */
export function assignmentSubscriptEnd(src: string, open: number, tokens: Token[]): number {
  const scan = scanOf(src);
  if (open >= scan.unplaceableFrom || !atAssignmentPosition(tokens)) return -1;
  const close = matchingBracket(src, open, scan);
  const after = close === -1 ? "" : readAhead(src, close + 1, 2).text;
  return after.startsWith("=") || after === "+=" ? close : -1;
}

/**
 * Index of the `]` matching the `[` at `open` when bash may read `NAME[...]` as one word but the join above was
 * not taken: after an unplaceable form, or at an assignment position with no `=` after the `]`. Bash joins on
 * position alone, so `#` there starts no comment and `<<` opens no heredoc. Returns -1 when bash splits too.
 */
export function ambiguousSubscriptEnd(src: string, open: number, tokens: Token[]): number {
  const scan = scanOf(src);
  const mayJoin = open >= scan.unplaceableFrom || atAssignmentPosition(tokens);
  if (!mayJoin || assignmentSubscriptEnd(src, open, tokens) !== -1) return -1;
  return matchingBracket(src, open, scan);
}

/**
 * What one source's subscript checks share, so each `[` costs constant time however long the source: the first
 * index from which `UNPLACEABLE_RE` has matched the source before it, and the brackets and spans found so far.
 */
interface SourceScan {
  unplaceableFrom: number;
  brackets: Map<number, number>;
  spans: SpanEnds;
}

/** Bounded, since nested readers lex slices of one command. */
const SCANS = new Map<string, SourceScan>();
const MAX_SOURCES = 64;

function scanOf(src: string): SourceScan {
  const known = SCANS.get(src);
  if (known) return known;
  const scan = { unplaceableFrom: unplaceableFrom(src), brackets: new Map<number, number>(), spans: new Map<number, number>() };
  if (SCANS.size >= MAX_SOURCES) SCANS.clear();
  SCANS.set(src, scan);
  return scan;
}

/**
 * The least `open` whose source before it, joins dropped, matches `UNPLACEABLE_RE`. A `[` follows every prefix
 * tested, so a match in the prefix is a match in the whole source that ends by `open`, and the reverse.
 */
function unplaceableFrom(src: string): number {
  const { text, rawAt } = joinedWithIndex(src);
  let from = Number.POSITIVE_INFINITY;
  UNPLACEABLE_RE.lastIndex = 0;
  for (let m = UNPLACEABLE_RE.exec(text); m; m = UNPLACEABLE_RE.exec(text)) {
    from = Math.min(from, (rawAt[m.index + m[0].length - 1] ?? src.length) + 1);
    UNPLACEABLE_RE.lastIndex = m.index + 1;
  }
  return from;
}

/** How far the assignment-position check has read one token list, so each token is tested once. */
interface Placement {
  seen: number;
  ok: boolean;
  reserved: boolean;
  pipelineStart: boolean;
}

const PLACEMENTS = new WeakMap<Token[], Placement>();

/**
 * True only where bash takes an assignment: after a control operator or at the start, past reserved words that
 * themselves start the command, then unquoted assignment words. A redirect, a reserved word after an assignment
 * (`A=1 then` is an argument) or anything else means the word splits as usual.
 */
function atAssignmentPosition(tokens: Token[]): boolean {
  const p = PLACEMENTS.get(tokens) ?? { seen: 0, ok: true, reserved: true, pipelineStart: true };
  PLACEMENTS.set(tokens, p);
  for (; p.seen < tokens.length; p.seen++) place(p, tokens[p.seen]);
  return p.ok;
}

function place(p: Placement, t: Token | undefined): void {
  if (t?.type === "op") {
    p.ok = CONTROL_OPERATORS.has(t.value);
    p.reserved = true;
    p.pipelineStart = !PIPES.has(t.value);
    return;
  }
  if (!p.ok) return;
  if (p.reserved && isWord(t, (w) => isReserved(w.value, p.pipelineStart))) {
    p.pipelineStart = false;
    return;
  }
  p.reserved = false;
  p.ok = isWord(t, (w) => ASSIGNMENT_WORD_RE.test(w.value));
}

/** How far a word's value has been checked as a name, so a long name before many brackets is read once. */
const NAMES = new WeakMap<WordToken, { checked: number; ok: boolean }>();

/** Whether the word read so far is a bare name; a word's value only grows, so the check resumes where it stopped. */
export function isNameSoFar(w: WordToken): boolean {
  const n = NAMES.get(w) ?? { checked: 0, ok: true };
  NAMES.set(w, n);
  for (; n.ok && n.checked < w.value.length; n.checked++) {
    n.ok = (n.checked === 0 ? IDENTIFIER_START : IDENTIFIER_PART).test(w.value.charAt(n.checked));
  }
  return n.ok && w.value.length > 0;
}

/** `time` is reserved only as the first word of a pipeline; elsewhere, even after `!` or `time`, it is a command name. */
function isReserved(value: string, pipelineStart: boolean): boolean {
  return COMMAND_STARTS.has(value) || (pipelineStart && value === "time");
}

function isWord(t: Token | undefined, test: (w: WordToken) => boolean): boolean {
  return t?.type === "word" && !t.quoted && test(t);
}

/**
 * Where each `$( )` or `${ }` in one source ends, by the position of its `$`. An unsure span is read again one
 * character at a time, which meets every span inside it a second time, so without this the cost doubles per level.
 */
type SpanEnds = Map<number, number>;

/**
 * Index of the `]` matching the `[` at `open`, skipping quoted text; -1 when it never closes. The scan from any
 * position is the same whichever `[` it began at, so it records every pair it closes on the way, and a source of
 * unclosed brackets is scanned once rather than once per bracket.
 */
function matchingBracket(src: string, open: number, scan: SourceScan): number {
  const known = scan.brackets.get(open);
  if (known !== undefined) return known;
  const pending: number[] = [];
  for (let j = open; j < src.length; j++) {
    const end = skipQuoted(src, j, scan.spans);
    if (end === -1) break;
    const c = end === j ? src[j] : "";
    if (c === "[") pending.push(j);
    const paired = c === "]" ? pending.pop() : undefined;
    if (paired !== undefined) scan.brackets.set(paired, j);
    if (paired === open) return j;
    j = end;
  }
  for (const unclosed of pending) scan.brackets.set(unclosed, -1);
  return -1;
}

/** Index of the last character of the escape or quoted run starting at `j`, `j` itself for any other character. */
function skipQuoted(src: string, j: number, spans: SpanEnds): number {
  const c = src[j];
  if (c === "\\") return j + 1;
  if (c === "'") return src.indexOf("'", j + 1);
  if (c === '"') return closingQuote(src, j + 1, '"');
  if (c === "`") return skippedSpan(j, closingBacktick(src, j));
  if (c === "$") return skipDollar(src, j, spans);
  return j;
}

/** Skips the `$'…'`, `$( )` or `${ }` the shared table finds after the `$` at `j`; a `$[` is left to the bracket count, which nests it. */
function skipDollar(src: string, j: number, spans: SpanEnds): number {
  const dollar = joinedDollar(src, j);
  const opener = dollarOpener(src, dollar);
  if (opener === "ansi-c") return closingQuote(src, dollar + 2, "'");
  if (opener === "paren" || opener === "braced") return skippedSpan(j, substitutionEnd(src, dollar, spans));
  return j;
}

function substitutionEnd(src: string, j: number, spans: SpanEnds): number {
  const known = spans.get(j);
  if (known !== undefined) return known;
  const paren = src[j + 1] === "(";
  const end = closingSubstitution(src, j + 2, paren ? "(" : "{", paren ? ")" : "}", spans);
  spans.set(j, end);
  return end;
}

/** An unsure span is not skipped: the bracket scan reads its characters one by one, as it did before spans were skipped. */
function skippedSpan(j: number, end: number): number {
  return end === UNSURE ? j : end;
}

/**
 * Index of the `close` ending a `$( )` or `${ }` body that starts at `from`, nesting and quotes included; UNSURE when
 * it never closes. A `#` in `$( )` may open a comment that hides the closer, and a `[` may open a nested spaced
 * subscript whose `)` or `}` is no closer, so the scan cannot be sure and returns UNSURE.
 */
function closingSubstitution(src: string, from: number, open: string, close: string, spans: SpanEnds): number {
  let depth = 1;
  for (let k = from; k < src.length; k++) {
    const end = skipQuoted(src, k, spans);
    if (end === -1) return UNSURE;
    const c = end === k ? src[k] : "";
    if (c === "[" || (c === "#" && open === "(")) return UNSURE;
    if (c === open) depth++;
    if (c === close && --depth === 0) return k;
    k = end;
  }
  return UNSURE;
}

/** Index of the next unescaped `quote` from `from`; -1 when there is none. */
function closingQuote(src: string, from: number, quote: string): number {
  for (let k = from; k < src.length; k++) {
    if (src[k] === "\\") k++;
    else if (src[k] === quote) return k;
  }
  return -1;
}

/** Index of the closing backtick; UNSURE when there is none or the span holds a `[` the scan cannot match. */
function closingBacktick(src: string, j: number): number {
  const end = closingQuote(src, j + 1, "`");
  return end === -1 || src.slice(j, end).includes("[") ? UNSURE : end;
}
