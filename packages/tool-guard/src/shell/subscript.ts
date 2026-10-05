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
 * the join alone.
 */
const UNPLACEABLE_RE = /\b(?:case|esac)\b|\[\[|\]\]|\(\(|\)\)|<<|[?*+@!]\(/;

const UNSURE = -2;

/**
 * Bash reads `NAME[...]` through the matching `]` as one word, blanks included, when it stands where an
 * assignment may and `=` or `+=` follows: `Y[ 0 ]=x git push` assigns element 0 and runs git.
 * Returns the index of that `]` for the `[` at `open`, or -1 when the word lexes as usual.
 */
export function assignmentSubscriptEnd(src: string, open: number, tokens: Token[]): number {
  if (UNPLACEABLE_RE.test(src.slice(0, open)) || !atAssignmentPosition(tokens)) return -1;
  const close = matchingBracket(src, open);
  const after = close === -1 ? "" : src.slice(close + 1, close + 3);
  return after.startsWith("=") || after === "+=" ? close : -1;
}

/**
 * True only where bash takes an assignment: after a control operator or at the start, past reserved words that
 * themselves start the command, then unquoted assignment words. A redirect, a reserved word after an assignment
 * (`A=1 then` is an argument) or anything else means the word splits as usual.
 */
function atAssignmentPosition(tokens: Token[]): boolean {
  let start = tokens.length;
  while (start > 0 && tokens[start - 1]?.type !== "op") start--;
  const before = tokens[start - 1];
  if (before?.type === "op" && !CONTROL_OPERATORS.has(before.value)) return false;
  const run = tokens.slice(start);
  const pipelineStart = before?.type !== "op" || !PIPES.has(before.value);
  let k = 0;
  while (k < run.length && isWord(run[k], (t) => isReserved(t.value, k === 0 && pipelineStart))) k++;
  return run.slice(k).every((t) => isWord(t, (w) => ASSIGNMENT_WORD_RE.test(w.value)));
}

/** `time` is reserved only as the first word of a pipeline; elsewhere, even after `!` or `time`, it is a command name. */
function isReserved(value: string, pipelineStart: boolean): boolean {
  return COMMAND_STARTS.has(value) || (pipelineStart && value === "time");
}

function isWord(t: Token | undefined, test: (w: WordToken) => boolean): boolean {
  return t?.type === "word" && !t.quoted && test(t);
}

/** Index of the `]` matching the `[` at `open`, skipping quoted text; -1 when it never closes. */
function matchingBracket(src: string, open: number): number {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const end = skipQuoted(src, j);
    if (end === -1) return -1;
    const c = end === j ? src[j] : "";
    if (c === "[") depth++;
    if (c === "]" && --depth === 0) return j;
    j = end;
  }
  return -1;
}

/** Index of the last character of the escape or quoted run starting at `j`, `j` itself for any other character. */
function skipQuoted(src: string, j: number): number {
  const c = src[j];
  if (c === "\\") return j + 1;
  if (c === "'") return src.indexOf("'", j + 1);
  if (c === '"') return closingQuote(src, j + 1, '"');
  if (c === "$" && src[j + 1] === "'") return closingQuote(src, j + 2, "'");
  if (c === "`") return skippedSpan(j, closingBacktick(src, j));
  if (c === "$" && src[j + 1] === "(") return skippedSpan(j, closingSubstitution(src, j + 2, "(", ")"));
  if (c === "$" && src[j + 1] === "{") return skippedSpan(j, closingSubstitution(src, j + 2, "{", "}"));
  return j;
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
function closingSubstitution(src: string, from: number, open: string, close: string): number {
  let depth = 1;
  for (let k = from; k < src.length; k++) {
    const end = skipQuoted(src, k);
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
