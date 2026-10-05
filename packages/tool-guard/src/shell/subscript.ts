import type { Token, WordToken } from "./lexer.js";

const ASSIGNMENT_WORD_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[.*\])?\+?=/s;
const CONTROL_OPERATORS = new Set([";", "&", "&&", "||", "|", "|&", "\n", "("]);
const COMMAND_STARTS = new Set(["{", "then", "do", "else", "elif", "if", "while", "until", "!", "time"]);

/**
 * Bash reads `NAME[...]` through the matching `]` as one word, blanks included, when it stands where an
 * assignment may and `=` or `+=` follows: `Y[ 0 ]=x git push` assigns element 0 and runs git.
 * Returns the index of that `]` for the `[` at `open`, or -1 when the word lexes as usual.
 */
export function assignmentSubscriptEnd(src: string, open: number, tokens: Token[]): number {
  if (!atAssignmentPosition(tokens)) return -1;
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
  let k = 0;
  while (k < run.length && isWord(run[k], (t) => COMMAND_STARTS.has(t.value))) k++;
  return run.slice(k).every((t) => isWord(t, (w) => ASSIGNMENT_WORD_RE.test(w.value)));
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
  return j;
}

/** Index of the next unescaped `quote` from `from`; -1 when there is none. */
function closingQuote(src: string, from: number, quote: string): number {
  for (let k = from; k < src.length; k++) {
    if (src[k] === "\\") k++;
    else if (src[k] === quote) return k;
  }
  return -1;
}
