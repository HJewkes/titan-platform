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
  const outer = at.trials.deepest;
  at.trials.deepest = 0;
  try {
    return expansionEnd(at, dollar, found);
  } finally {
    at.trials.deepest = Math.max(outer, at.trials.deepest);
  }
}

function expansionEnd(at: Reading, dollar: number, found: Token[][]): number {
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

const PLAIN_MATH = /^[\w \t\r\n+\-*/%<>=!&|^~?:,.$()[\]]*$/;

/**
 * Whether no shell can read a paren in `body` differently from balancedEnd. Quotes, backquotes, backslashes, comments,
 * braces, `;` and the like can hide a paren, and zsh also reads a body with an unbalanced `[` or `]` as a command, so a
 * body is plain only when it is made of characters that hide nothing, its brackets balance and its parens never close
 * more than they opened.
 */
function isPlainMath(body: string): boolean {
  if (!PLAIN_MATH.test(body)) return false;
  let parens = 0;
  let brackets = 0;
  for (const c of body) {
    if (c === "(") parens++;
    else if (c === ")") parens--;
    else if (c === "[") brackets++;
    else if (c === "]") brackets--;
    if (parens < 0 || brackets < 0) return false;
  }
  return parens === 0 && brackets === 0;
}

/**
 * zsh reads any `$(( ))` body that is not plain math as `$( ( … ) )`, and bash does for some, running what the
 * arithmetic reading calls arithmetic. Those commands are walked too; a body that cannot be lexed that way is refused.
 * Both readings of a span nested in another are costly to walk, so nesting past `MAX_BOTH_READINGS` is refused.
 */
function withSubshellReading(at: Reading, dollar: number, end: number, found: Token[][], primary: Token[][]): number {
  found.push(...primary);
  if (at.trials.inSubshellReading || isPlainMath(at.src.slice(dollar + 3, end - 1))) return end;
  const depth = bothReadingsDepth(at.trials, dollar);
  if (depth > MAX_BOTH_READINGS) throw new ParseError("arithmetic read two ways nests too deep");
  let tokens = at.trials.subshells.get(dollar);
  if (tokens === undefined) {
    tokens = [lexSubshellReading(at, dollar)];
    at.trials.subshells.set(dollar, tokens);
  }
  found.push(...tokens);
  return end;
}

const MAX_BOTH_READINGS = 4;

/** How many spans read two ways nest at `dollar`, itself included; the inner ones were met first, in the primary reading. */
function bothReadingsDepth(trials: ArithTrials, dollar: number): number {
  const depth = trials.depths.get(dollar) ?? trials.deepest + 1;
  trials.depths.set(dollar, depth);
  trials.deepest = Math.max(trials.deepest, depth);
  return depth;
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
