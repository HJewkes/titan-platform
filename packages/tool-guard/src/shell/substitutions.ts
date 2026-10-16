import { newTrials, sameSpend } from "./arith-trials.js";
import { type NestedReaders, refuseValueRun } from "./balanced.js";
import { joinedDollar, nextAfter } from "./joins.js";
import { nestedReaders, type Reading } from "./nested-reading.js";
import { refusingAs } from "./parse-error.js";
import type { Token } from "./tokens.js";

/**
 * Bash runs a substitution in a single-quoted span only when its `${ }` sits in double quotes, and
 * otherwise reads the text as literal, so one left unclosed there cannot be a pass: it is refused.
 */
export function quotedSpanSubstitutions(at: Reading, from: number, to: number): Token[][] {
  return refusingAs("quoted-substitution", () => scanSubstitutions(at.src.slice(from, to), 0, to - from, sameSpend(at.trials)));
}

/** Token lists of every substitution in `src` between `from` and `to`, such as a heredoc body's. */
export function scanSubstitutions(src: string, from: number, to: number, trials = newTrials(src)): Token[][] {
  const found: Token[][] = [];
  const read = nestedReaders({ src, trials, line: null }, found);
  for (let j = from; j < to; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === "$") j = scanDollar(src, j, read);
    else if (c === "`") j = read.backtick(j);
  }
  return found;
}

function scanDollar(src: string, j: number, read: NestedReaders): number {
  const dollar = joinedDollar(src, j);
  refuseValueRun(src, dollar);
  return src[dollar + 1] === "(" ? dollarParen(src, dollar, read) : j;
}

function dollarParen(src: string, dollar: number, read: NestedReaders): number {
  return src[nextAfter(src, dollar + 1)] === "(" ? read.dollarParens(dollar) : read.substitution(dollar + 2);
}
