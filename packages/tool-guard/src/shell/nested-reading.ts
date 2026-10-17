import { type ArithTrials, sameSpend } from "./arith-trials.js";
import { backtickEnd, balancedEnd, type NestedReaders } from "./balanced.js";
import { nextAfter } from "./joins.js";
import { lexNested, tokenize } from "./lexer.js";
import { nested } from "./nesting.js";
import { ParseError, refusingAs, SplitParseError } from "./parse-error.js";
import { quotedSpanSubstitutions } from "./substitutions.js";
import type { LexState, Token } from "./tokens.js";

/** Where substitutions are lexed: `line` is null in a heredoc body or a quoted span, which has no line to leave a heredoc open on. */
export interface Reading {
  src: string;
  trials: ArithTrials;
  line: LexState | null;
}

export function lineReading(s: LexState): Reading {
  return { src: s.src, trials: s.trials, line: s };
}

/**
 * Last index of the `$((` at `dollar` when bash reads arithmetic, or -1 when it reads `$( (…) … )`:
 * as `markDoubleParen` does for `((`, the `)` matching the second `(` must be followed by another.
 * Each decision is kept per position, so a subshell reading that lexes the text again stays polynomial.
 */
export function arithmeticExpansionEnd(at: Reading, dollar: number, found: Token[][]): number {
  const known = at.trials.ends.get(dollar);
  if (known === -1) return -1;
  if (known !== undefined) return withSubshellReading(at, dollar, known, found, arithmeticTokens(at, dollar));
  const trial: Token[][] = [];
  const end = arithmeticTrial(at, dollar, trial);
  at.trials.ends.set(dollar, end);
  if (end === -1) return -1;
  at.trials.arithmetic.set(dollar, trial);
  return withSubshellReading(at, dollar, end, found, trial);
}

function arithmeticTokens(at: Reading, dollar: number): Token[][] {
  const kept = at.trials.arithmetic.get(dollar);
  if (kept !== undefined) return kept;
  const rescanned: Token[][] = [];
  balancedEnd(at.src, dollar + 1, nestedReaders(at, rescanned));
  at.trials.arithmetic.set(dollar, rescanned);
  return rescanned;
}

/**
 * A body holding a character that balancedEnd reads as opaque while the shells may not (a quote, a backquote, a
 * backslash, a `#` that opens a comment, a newline) can be read by zsh, and sometimes bash, as `$( ( … ) )`, running
 * what the arithmetic reading calls arithmetic. Those commands are walked too; a body that cannot be lexed that way
 * is refused.
 */
const HIDES_PAREN = /['"\\`#\n]/;

function withSubshellReading(at: Reading, dollar: number, end: number, found: Token[][], primary: Token[][]): number {
  found.push(...primary);
  if (at.trials.inSubshellReading || !HIDES_PAREN.test(at.src.slice(dollar + 3, end - 1))) return end;
  let tokens = at.trials.subshells.get(dollar);
  if (tokens === undefined) {
    tokens = [lexSubshellReading(at, dollar)];
    at.trials.subshells.set(dollar, tokens);
  }
  found.push(...tokens);
  return end;
}

function lexSubshellReading(at: Reading, dollar: number): Token[] {
  at.trials.inSubshellReading = true;
  try {
    return lexNested(at.src, dollar + 2, at.trials, at.line).tokens;
  } finally {
    at.trials.inSubshellReading = false;
  }
}

function arithmeticTrial(at: Reading, dollar: number, trial: Token[][]): number {
  try {
    const inner = balancedEnd(at.src, nextAfter(at.src, dollar + 1), nestedReaders(at, trial));
    const close = nextAfter(at.src, inner);
    return at.src[close] === ")" ? close : -1;
  } catch (error) {
    if (error instanceof ParseError && !(error instanceof SplitParseError)) return -1;
    throw error;
  }
}

export function nestedReaders(at: Reading, found: Token[][]): NestedReaders {
  const read: NestedReaders = {
    substitution: (start) => {
      const inner = lexNested(at.src, start, at.trials, at.line);
      found.push(inner.tokens);
      return inner.i;
    },
    backtick: (start) => scanBacktick(at.src, start, found, at.trials),
    quotedSpan: (from, to) => found.push(...quotedSpanSubstitutions(at, from, to)),
    nesting: at.trials.nesting,
    dollarParens: (dollar) =>
      refusingAs("unclosed-expansion", () => {
        const end = arithmeticExpansionEnd(at, dollar, found);
        return end === -1 ? read.substitution(dollar + 2) : end;
      }),
  };
  return read;
}

export function scanBacktick(src: string, start: number, found: Token[][], trials: ArithTrials): number {
  const end = backtickEnd(src, start);
  found.push(nested(trials.nesting, () => tokenize(src.slice(start + 1, end).replace(/\\([`\\$])/g, "$1"), sameSpend(trials))));
  return end;
}
