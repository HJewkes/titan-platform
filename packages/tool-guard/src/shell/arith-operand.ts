import { ParseError } from "./parse-error.js";
import type { LexState, WordToken } from "./tokens.js";

const ARITH_TEST_OPERATORS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
/** What `appendLiteral` looks for: any `$(`, `$((` included since bash 5.3 rereads it as `$( (`, any `${`, which may open a funsub (`${ c;}`, `${|c;}`), or a backtick. */
export const CODE_TEXT_RE = /\$[({]|`/;
const SUBSCRIPTED_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*\[.*\]\+?=/s;
/** An element of `NAME=( … )`, whose subscript bash evaluates for an indexed array. */
const ELEMENT_ASSIGNMENT_RE = /^\[.*\]\+?=/s;

export const CODE_TEXT_REASON = "a command substitution written as text in an arithmetic subscript or [[ -eq ]] operand runs when bash evaluates it";

interface TestScan {
  open: boolean;
  operator: boolean;
  codeText: boolean;
}

const TESTS = new WeakMap<LexState, TestScan>();

/**
 * The one place a `$(` or backtick left in a value as text is refused where bash evaluates that value as arithmetic:
 * the subscript of an assignment word (`a[$(c)]=1`) and the operands of `[[ -eq ]]`. However the text got there
 * (a single quote, an escape, a double-quoted escape) and wherever on the line the word stands, the word's value is what
 * bash evaluates, so this checks the value rather than the spelling or the position.
 */
export function refuseCodeInArithmeticValue(s: LexState, w: WordToken): void {
  const codeText = w.codeText === true;
  if (codeText && (SUBSCRIPTED_ASSIGNMENT_RE.test(w.value) || (s.compoundDepth !== -1 && ELEMENT_ASSIGNMENT_RE.test(w.value)))) throw new ParseError(CODE_TEXT_REASON);
  const scan = TESTS.get(s) ?? { open: false, operator: false, codeText: false };
  TESTS.set(s, scan);
  if (!w.quoted && w.value === "[[") Object.assign(scan, { open: true, operator: false, codeText: false });
  else if (!w.quoted && w.value === "]]") scan.open = false;
  else if (scan.open) {
    scan.operator ||= !w.quoted && ARITH_TEST_OPERATORS.has(w.value);
    scan.codeText ||= codeText;
    if (scan.operator && scan.codeText) throw new ParseError(CODE_TEXT_REASON);
  }
}
