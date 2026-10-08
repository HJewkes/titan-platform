import { type LexState, lex, newState, ParseError, type Token } from "./lexer.js";
import type { ArithTrials } from "./arith-trials.js";

type Pending = LexState["heredocs"];

const tails = new WeakMap<ArithTrials, Set<number>>();

/** Text readings found while lexing a tail, kept flat so a long run of them does not nest deeper each time. */
let collected: Token[][] | null = null;

/**
 * A heredoc still pending when a process substitution closes takes its body from the lines after
 * the current one in bash 5, and not at all in bash 3.2, which lexes those lines as commands. No single
 * reading is safe for both, so both are returned: the first list is the one bash 3.2 gives (and the
 * one this lexer always gave), the others are the text after the body that bash 5 skips. Each such text
 * is returned once, by the first substitution that reaches it.
 */
export function readProcessSubstitution(s: LexState, start: number): Token[][] {
  const inner = newState(s.src, start, true, s.trials);
  lex(inner);
  s.i = inner.i + 1;
  if (inner.heredocs.length === 0) return [inner.tokens];
  const pending = [...s.heredocs, ...inner.heredocs];
  if (collected !== null) {
    const tail = tailAfterBodies(s, inner.i, pending);
    if (tail) collected.push(tail);
    return [inner.tokens];
  }
  collected = [];
  try {
    const tail = tailAfterBodies(s, inner.i, pending);
    return tail ? [inner.tokens, tail, ...collected] : [inner.tokens];
  } finally {
    collected = null;
  }
}

/** The tokens of a text no earlier substitution has returned, or null. */
function tailAfterBodies(s: LexState, from: number, pending: Pending): Token[] | null {
  const start = skipBodies(s.src, from, pending);
  if (start === null) return null;
  const seen = tails.get(s.trials) ?? new Set<number>();
  tails.set(s.trials, seen);
  if (seen.has(start)) return null;
  seen.add(start);
  return lexTail(s, start);
}

/** Tokens of the rest of the source; a tail that does not lex adds nothing beyond the first reading. */
function lexTail(s: LexState, start: number): Token[] {
  const state = newState(s.src, start, false, s.trials);
  try {
    lex(state);
  } catch (error) {
    if (error instanceof ParseError) return [];
    throw error;
  }
  return state.tokens;
}

/** Index just past the last body line, or null when a delimiter is missing or the bodies reach the end. */
function skipBodies(src: string, from: number, pending: Pending): number | null {
  let i = src.indexOf("\n", from);
  for (const { token, stripTabs } of pending) {
    const delim = token.target?.value;
    if (i === -1 || delim === undefined) return null;
    i = afterDelimiter(src, i + 1, delim, stripTabs);
  }
  return i === -1 || i >= src.length ? null : i;
}

function afterDelimiter(src: string, from: number, delim: string, stripTabs: boolean): number {
  let i = from;
  while (i < src.length) {
    const newline = src.indexOf("\n", i);
    const end = newline === -1 ? src.length : newline;
    const line = stripTabs ? src.slice(i, end).replace(/^\t+/, "") : src.slice(i, end);
    if (line === delim) return end + 1;
    i = end + 1;
  }
  return -1;
}
