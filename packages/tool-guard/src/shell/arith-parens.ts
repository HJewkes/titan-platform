import type { Token } from "./tokens.js";

/** The parentheses still open inside an `(( ))` after the tokens, counted from `open` already open. */
export function arithmeticParens(tokens: Token[], open = 0): number {
  let parens = open;
  for (const token of tokens) {
    if (token.type !== "op") continue;
    if (token.value === "(" && (parens > 0 || token.arith === true)) parens++;
    else if (token.value === ")" && parens > 0) parens--;
  }
  return parens;
}
