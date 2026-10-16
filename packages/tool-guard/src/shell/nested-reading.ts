import { type ArithTrials, newTrials, sameSpend } from "./arith-trials.js";
import { backtickEnd, balancedEnd, type NestedReaders } from "./balanced.js";
import { joinedDollar, nextAfter } from "./joins.js";
import { lexNested, tokenize } from "./lexer.js";
import { nested } from "./nesting.js";
import { ParseError, refusingAs, SplitParseError } from "./parse-error.js";
import type { LexState, Token } from "./tokens.js";

/** Where substitutions are lexed: `line` is null in a heredoc body or a quoted span, which has no line to leave a heredoc open on. */
interface Reading {
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
  if (known !== undefined) return known === -1 ? -1 : balancedEnd(at.src, dollar + 1, nestedReaders(at, found));
  const trial: Token[][] = [];
  const end = arithmeticTrial(at, dollar, trial);
  at.trials.ends.set(dollar, end);
  if (end !== -1) found.push(...trial);
  return end;
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

/**
 * Bash runs a substitution in a single-quoted span only when its `${ }` sits in double quotes, and
 * otherwise reads the text as literal, so one left unclosed there cannot be a pass: it is refused.
 */
function quotedSpanSubstitutions(at: Reading, from: number, to: number): Token[][] {
  return refusingAs("quoted-substitution", () => scanSubstitutions(at.src.slice(from, to), 0, to - from, sameSpend(at.trials)));
}

/** Token lists of every substitution in `src` between `from` and `to`, such as a heredoc body's. */
export function scanSubstitutions(src: string, from: number, to: number, trials = newTrials(src)): Token[][] {
  const found: Token[][] = [];
  const read = nestedReaders({ src, trials, line: null }, found);
  for (let j = from; j < to; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === "$" && src[joinedDollar(src, j) + 1] === "(") j = dollarParen(src, joinedDollar(src, j), read);
    else if (c === "`") j = read.backtick(j);
  }
  return found;
}

function dollarParen(src: string, dollar: number, read: NestedReaders): number {
  return src[nextAfter(src, dollar + 1)] === "(" ? read.dollarParens(dollar) : read.substitution(dollar + 2);
}

export function scanBacktick(src: string, start: number, found: Token[][], trials: ArithTrials): number {
  const end = backtickEnd(src, start);
  found.push(nested(trials.nesting, () => tokenize(src.slice(start + 1, end).replace(/\\([`\\$])/g, "$1"), sameSpend(trials))));
  return end;
}
