import type { Token, WordToken } from "./lexer.js";
import { compoundEnd } from "./writers.js";

const COMMAND_OPENERS = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "time"]);
const OPERATOR_RE = /^[-+*/%<>=!&|^~?:,]+$/;
const OPERAND_RE = /^[\w.#@$[\]{}+\-*/%<>=!&|^~?:,]+$/;

/**
 * Whether `text` splits a `))` or a `((` with a backslash-newline. Bash does not read a split `))` as one, and zsh
 * does not join a split `((`, so it runs `(\<NL>(./push.sh))` as nested subshells where the lexer marks arithmetic.
 */
export const splitsClose = (text: string) => /\)(?:\\\n)+\)|\((?:\\\n)+\(/.test(text);

/**
 * The index of the `)` that ends the arithmetic command a marked `(` at `at` opens in command position, or -1 when
 * the token opens none. Bash reads `((git push))` as arithmetic and never runs it, but only a span arithmetic can
 * hold is taken as one; any other stays a nested subshell, so it fails closed. So does every `((` where `allowed` is
 * false: the shell running it has no arithmetic command (dash), or the text splits a `((` or `))` with a
 * backslash-newline, which bash or zsh reads as a subshell that runs what is inside.
 */
export function arithmeticSpanEnd(list: Token[], at: number, words: WordToken[], allowed: boolean): number {
  const token = list[at];
  if (!allowed || token?.type !== "op" || token.arith !== true || !words.every((w) => COMMAND_OPENERS.has(w.value))) return -1;
  const end = compoundEnd(list, at + 2);
  return end < 0 || !onlyArithmetic(list.slice(at + 2, end - 1)) ? -1 : end;
}

/**
 * Whether a span holds only what arithmetic can: words that are operands or operators, and parentheses. No redirect,
 * separator, empty `()` or `--`, and no two neighbouring words without an operator or a subscript bracket between them.
 */
function onlyArithmetic(span: Token[]): boolean {
  const words = span.flatMap((t) => (t.type === "word" ? [t] : []));
  const parens = span.every((t) => t.type === "word" || (t.type === "op" && (t.value === "(" || t.value === ")")));
  const count = (c: string) => words.reduce((n, w) => n + w.value.split(c).length - 1, 0);
  const header = span.some((t, i) => isParen(t, "(") && isParen(span[i + 1], ")"));
  return parens && !header && words.every(operandOrOperator) && count("[") === count("]") && span.every((t, i) => joined(t, span[i + 1]));
}

/** An empty `()` reads as a function header, which the value marks treat as opaque. */
const isParen = (t: Token | undefined, value: string) => t?.type === "op" && t.value === value;

function operandOrOperator(word: WordToken): boolean {
  if (word.value === "--" || word.quoted || word.spliced) return false;
  return word.dynamic || OPERATOR_RE.test(word.value) || OPERAND_RE.test(word.value);
}

/** Two words side by side read as a command unless an operator or a subscript bracket sits between them. */
function joined(a: Token, b: Token | undefined): boolean {
  if (a.type !== "word" || b?.type !== "word") return true;
  return OPERATOR_RE.test(a.value) || OPERATOR_RE.test(b.value) || a.value.endsWith("[") || b.value.startsWith("]");
}
