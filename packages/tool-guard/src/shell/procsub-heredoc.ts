import { type LexState, lex, newState, ParseError, type Token } from "./lexer.js";

/**
 * A heredoc still pending when a process substitution closes takes its body from the lines after
 * the current one in bash 5 and not at all in bash 3.2. No reading is safe for both, so it fails closed.
 */
export function readProcessSubstitution(s: LexState, start: number): Token[] {
  const inner = newState(s.src, start, true, s.trials);
  lex(inner);
  if (inner.heredocs.length > 0) throw new ParseError("heredoc body outside its process substitution");
  s.i = inner.i + 1;
  return inner.tokens;
}
