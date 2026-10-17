import type { LexState } from "./tokens.js";

const ARITH_TEST_OPERATORS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
const ARITH_TEST_AHEAD_RE = /(?:^|\s)-(?:eq|ne|lt|le|gt|ge)(?:\s|$)/;

/** The `[[ ]]` the last check read, so each quote in it asks the same question once. */
const CHECKED = new WeakMap<LexState, { end: number; arithmetic: boolean }>();

/**
 * Whether the `[` or `[[` test the lexer is in compares with `-eq`, `-ne`, `-lt`, `-le`, `-gt` or `-ge`. Both operands
 * of those are arithmetic, so bash expands a single quote there like a double quote and runs a `$(` inside. Which
 * word is an operand is not tracked: any quote in a `[[ ]]` that holds such an operator is read that way.
 */
export function inArithmeticTest(s: LexState): boolean {
  const known = CHECKED.get(s);
  if (known && s.i < known.end) return known.arithmetic;
  const open = openTest(s);
  if (open === -1) return false;
  const closeAt = s.src.indexOf("]]", s.i);
  const end = closeAt === -1 ? s.src.length : closeAt;
  const seen = s.tokens.slice(open).some((t) => t.type === "word" && !t.quoted && ARITH_TEST_OPERATORS.has(t.value));
  const arithmetic = seen || ARITH_TEST_AHEAD_RE.test(s.src.slice(s.i, end));
  CHECKED.set(s, { end, arithmetic });
  return arithmetic;
}

/** Index of the `[[` word the unfinished test began at, or -1 when the last `[[` was closed or none was read. */
function openTest(s: LexState): number {
  for (let k = s.tokens.length - 1; k >= 0; k--) {
    const t = s.tokens[k];
    if (t?.type !== "word" || t.quoted) continue;
    if (t.value === "]]") return -1;
    if (t.value === "[[") return k;
  }
  return -1;
}

const DECLARERS = new Set(["declare", "typeset", "local", "export", "readonly"]);

/**
 * Whether the `[ … ]` span bash may read as one word is an array subscript there: an element of `NAME=( … )`, or the
 * subscript of a name a declaring builtin takes. Both are arithmetic for an indexed array, so a quote in one runs a `$(`.
 */
export function inArraySubscript(s: LexState): boolean {
  if (s.compoundDepth !== -1) return true;
  for (let k = s.tokens.length - 1; k >= 0; k--) {
    const t = s.tokens[k];
    if (t?.type === "op") return false;
    if (t?.type === "word" && !t.quoted && DECLARERS.has(t.value)) return true;
  }
  return false;
}
