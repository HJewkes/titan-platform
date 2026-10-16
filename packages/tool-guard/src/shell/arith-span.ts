import type { Token, WordToken } from "./lexer.js";
import { compoundEnd } from "./writers.js";

const COMMAND_OPENERS = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "time"]);
const ARITH_OPERATOR_RE = /^[-+*/%<>=!&|^~?:,]+$/;
const NAME_LIKE_RE = /^[A-Za-z_/.][\w./=-]*$/;

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

const SEPARATORS = new Set([";", "\n"]);

/** A word this test cannot read as an operator or a subscript opener: a literal name or path, or any non-literal word. */
function nameLike(word: WordToken): boolean {
  return word.dynamic || word.quoted || word.spliced || NAME_LIKE_RE.test(word.value);
}

/** A command separator, or a name-like word followed, past an `--`, by a word that is no operator, reads as a command. */
function readsAsCommand(span: Token[]): boolean {
  return span.some((t, i) => {
    if (t.type === "op") return SEPARATORS.has(t.value);
    if (t.type !== "word" || !nameLike(t)) return false;
    const next = span[i + 1];
    const after = next?.type === "word" && next.value === "--" ? span[i + 2] : next;
    return after?.type === "word" && !ARITH_OPERATOR_RE.test(after.value);
  });
}
