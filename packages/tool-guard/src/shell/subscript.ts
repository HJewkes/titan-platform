import type { Token } from "./lexer.js";

const ASSIGNMENT_WORD_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[.*\])?\+?=/s;
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

/** True when only assignments, redirections or reserved words stand between the last operator and here. */
function atAssignmentPosition(tokens: Token[]): boolean {
  for (let k = tokens.length - 1; k >= 0; k--) {
    const t = tokens[k] as Token;
    if (t.type === "op") return t.value !== ";;";
    if (t.type === "subs") return false;
    if (t.type === "word" && !ASSIGNMENT_WORD_RE.test(t.value) && (t.quoted || !COMMAND_STARTS.has(t.value))) return false;
  }
  return true;
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
  if (c !== '"') return j;
  for (let k = j + 1; k < src.length; k++) {
    if (src[k] === "\\") k++;
    else if (src[k] === '"') return k;
  }
  return -1;
}
