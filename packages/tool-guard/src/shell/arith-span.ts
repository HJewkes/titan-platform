import type { Token, WordToken } from "./lexer.js";
import { compoundEnd } from "./writers.js";

const COMMAND_OPENERS = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "time"]);
const ARITH_OPERATOR_RE = /^[-+*/%<>=!&|^~?:,]+$/;
const NAME_LIKE_RE = /^[A-Za-z_][\w.-]*$/;

/**
 * The index of the `)` that ends the arithmetic command a marked `(` at `at` opens in command position, or -1 when
 * the token opens none. A span whose words look like a command, `git push`, is kept as a nested subshell: bash
 * reads `((git push))` as arithmetic and never runs it, but this fails closed.
 */
export function arithmeticSpanEnd(list: Token[], at: number, words: WordToken[]): number {
  const token = list[at];
  if (token?.type !== "op" || token.arith !== true || !words.every((w) => COMMAND_OPENERS.has(w.value))) return -1;
  const end = compoundEnd(list, at + 2);
  return end < 0 || readsAsCommand(list.slice(at + 2, end - 1)) ? -1 : end;
}

function readsAsCommand(span: Token[]): boolean {
  const first = span.findIndex((t) => t.type === "word");
  const head = span[first];
  const next = span[first + 1];
  if (head?.type !== "word" || !NAME_LIKE_RE.test(head.value)) return false;
  return next?.type === "word" && !ARITH_OPERATOR_RE.test(next.value);
}
