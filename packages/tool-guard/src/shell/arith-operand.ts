import { ParseError } from "./parse-error.js";
import type { WordToken } from "./tokens.js";

const COMPARISON_RE = /^-(?:eq|ne|lt|le|gt|ge)$/;
/** What `appendLiteral` looks for: any `$(`, `$((` included since bash 5.3 rereads it as `$( (`, any `${`, which may open a funsub (`${ c;}`, `${|c;}`), or a backtick. */
export const CODE_TEXT_RE = /\$[({]|`/g;
/** The subscript of an assignment word; greedy, so a later `]=` only widens the span and the check fails closed. */
const SUBSCRIPTED_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*\[(.*)\]\+?=/s;
/** An element of `NAME=( … )`, whose subscript bash evaluates for an indexed array. */
const ELEMENT_ASSIGNMENT_RE = /^\[(.*)\]\+?=/s;

export const CODE_TEXT_REASON = "a command substitution written as text in an arithmetic subscript or [[ -eq ]] operand runs when bash evaluates it";

function refuse(): never {
  throw new ParseError(CODE_TEXT_REASON);
}

/** Whether the word spelled out a `$(`, `${` or backtick at or after `from` and before `to`; only text a word wrote, not an expansion's output. */
function codeTextBetween(w: WordToken, from: number, to: number): boolean {
  return (w.codeAt ?? []).some((at) => at >= from && at < to);
}

/**
 * The one place a `$(`, `${` or backtick left in a value as text is refused where bash evaluates that value as
 * arithmetic, however the text got there (a single quote, an escape, ANSI-C) and wherever on the line the command
 * stands. Only the arithmetic span counts: the subscript of an assignment word or compound-array element, and the two
 * operands of `-eq`, `-ne`, `-lt`, `-le`, `-gt` and `-ge`. The same text after the `]=`, or in a string, runs nothing.
 */
export function refuseCodeInSubscripts(assigning: WordToken[], elements: WordToken[]): void {
  for (const w of assigning) {
    const subscript = w.codeAt && SUBSCRIPTED_ASSIGNMENT_RE.exec(w.value)?.[1];
    const from = w.value.indexOf("[") + 1;
    if (subscript !== undefined && subscript !== false && codeTextBetween(w, from, from + subscript.length)) refuse();
  }
  for (const w of elements) {
    const subscript = w.codeAt && ELEMENT_ASSIGNMENT_RE.exec(w.value)?.[1];
    if (subscript !== undefined && subscript !== false && codeTextBetween(w, 1, 1 + subscript.length)) refuse();
  }
}

/** A numeric comparison evaluates both neighbours of its operator, and `[ ]` and `test`, which `testCommand` names, do not. */
export function refuseCodeInOperands(words: WordToken[], testCommand: boolean): void {
  if (testCommand) return;
  words.forEach((w, i) => {
    if (w.quoted || !COMPARISON_RE.test(w.value)) return;
    for (const operand of [words[i - 1], words[i + 1]]) if (operand?.codeAt) refuse();
  });
}
