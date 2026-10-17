import type { LexState, Token } from "./tokens.js";

const ARITH_TEST_OPERATORS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
const ARITH_TEST_AHEAD_RE = /(?:^|\s)-(?:eq|ne|lt|le|gt|ge)(?:\s|$)/;

/** How far one lexer's tokens have been read for the `[[` still open, so each token is read once however many quotes follow. */
interface TestScan {
  seen: number;
  open: boolean;
  operator: boolean;
  /** The `]]` the forward look found, and whether an operator stands before it. */
  ahead: { end: number; operator: boolean } | null;
}

const SCANS = new WeakMap<LexState, TestScan>();

/**
 * Whether the `[[` test the lexer is in compares with `-eq`, `-ne`, `-lt`, `-le`, `-gt` or `-ge`. Both operands
 * of those are arithmetic, so bash expands a single quote there like a double quote and runs a `$(` inside. Which
 * word is an operand is not tracked: any quote in a `[[ ]]` that holds such an operator is read that way.
 */
export function inArithmeticTest(s: LexState): boolean {
  const scan = SCANS.get(s) ?? { seen: 0, open: false, operator: false, ahead: null };
  SCANS.set(s, scan);
  for (; scan.seen < s.tokens.length; scan.seen++) readToken(scan, s.tokens[scan.seen]);
  if (!scan.open) return false;
  if (scan.operator) return true;
  if (!scan.ahead || s.i >= scan.ahead.end) {
    const closeAt = s.src.indexOf("]]", s.i);
    const end = closeAt === -1 ? s.src.length : closeAt;
    scan.ahead = { end, operator: ARITH_TEST_AHEAD_RE.test(s.src.slice(s.i, end)) };
  }
  return scan.ahead.operator;
}

function readToken(scan: TestScan, t: Token | undefined): void {
  if (t?.type !== "word" || t.quoted) return;
  if (t.value === "[[") Object.assign(scan, { open: true, operator: false, ahead: null });
  else if (t.value === "]]") scan.open = false;
  else if (ARITH_TEST_OPERATORS.has(t.value)) scan.operator ||= scan.open;
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
