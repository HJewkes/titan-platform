import { type ArithTrials, chargeTrial, newTrials, spent } from "./arith-trials.js";
import { endWord, type LexState, lex, newState, ParseError, step, type Token } from "./lexer.js";

type Pending = LexState["heredocs"];

/** What is known about one source's tails. The trials are the tails' own: main's `((` positions and budget stay untouched. */
interface Book {
  src: string;
  trials: ArithTrials;
  tokens: Map<number, Token[] | null>;
  attached: Set<number>;
}

const books = new WeakMap<ArithTrials, Book>();
const budgets = new WeakMap<ArithTrials["spend"], ArithTrials["spend"]>();

/** Tail starts met while a tail is being read; null outside of that. */
let queue: number[] | null = null;
let known: Set<number> = new Set();

/**
 * A heredoc still pending when a process substitution closes takes its body from the lines after
 * the current one in bash 5, and not at all in bash 3.2, which lexes those lines as commands. No single
 * reading is safe for both, so both are returned: the first list is the one bash 3.2 gives (and the
 * one this lexer always gave), the others are the text after the bodies that bash 5 skips. Each such
 * text is lexed once, stops where the next one begins, is returned once, and is charged by the length read;
 * once the budget is spent only the first reading is returned, which is what main gives.
 */
export function readProcessSubstitution(s: LexState, start: number): Token[][] {
  const inner = newState(s.src, start, true, s.trials);
  lex(inner);
  s.i = inner.i + 1;
  const first: Token[][] = [inner.tokens];
  if (inner.heredocs.length === 0 || s.arithEnd === Number.POSITIVE_INFINITY) return first;
  const at = skipBodies(s.src, inner.i, [...s.heredocs, ...inner.heredocs]);
  if (at === null) return first;
  if (queue !== null) {
    queue.push(at);
    known.add(at);
    return first;
  }
  return [...first, ...readTails(bookOf(s), at)];
}

function bookOf(s: LexState): Book {
  const found = books.get(s.trials);
  if (found) return found;
  const spend = budgets.get(s.trials.spend) ?? newTrials(s.src).spend;
  budgets.set(s.trials.spend, spend);
  const trials = { ends: new Map<number, number>(), spend };
  const book = { src: s.src, trials, tokens: new Map(), attached: new Set<number>() };
  books.set(s.trials, book);
  books.set(trials, book);
  return book;
}

/** The tail at `at` and every tail met while reading it, each only if no earlier call returned it. */
function readTails(book: Book, at: number): Token[][] {
  const out: Token[][] = [];
  const work = [at];
  queue = work;
  known = new Set([at]);
  try {
    for (let next = work.pop(); next !== undefined; next = work.pop()) {
      if (book.attached.has(next)) continue;
      book.attached.add(next);
      const tokens = book.tokens.get(next) ?? readTail(book, next);
      book.tokens.set(next, tokens);
      if (tokens) out.push(tokens);
    }
  } finally {
    queue = null;
  }
  return out;
}

/** Tokens of the text from `start`, or null once the budget is spent; a text that does not lex adds nothing. */
function readTail(book: Book, start: number): Token[] | null {
  if (spent(book.trials)) return null;
  const state = newState(book.src, start, false, book.trials);
  try {
    while (state.i < book.src.length && !(state.i > start && joinsKnownTail(state))) step(state);
    endWord(state);
  } catch (error) {
    if (error instanceof ParseError) return [];
    throw error;
  }
  return chargeTrial(book.trials, state.i - start) ? state.tokens : null;
}

/** At a clean command boundary where another tail begins, reading on would only repeat that tail. */
function joinsKnownTail(s: LexState): boolean {
  const clean = !s.word && !s.redirect && s.depth === 0 && s.heredocs.length === 0 && s.i >= s.subscriptEnd && s.i >= s.arithEnd;
  return clean && known.has(s.i);
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
