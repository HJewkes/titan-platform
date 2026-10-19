import { type ArithTrials, sameSpend } from "./arith-trials.js";
import { mathCutByWindow } from "./assign-on-expand.js";
import { backtickEnd, balancedEnd, type NestedReaders, refusingMisreadLongMath, refusingMisreadMath, unreadExpansion } from "./balanced.js";
import { nextAfter } from "./joins.js";
import { lexNested, tokenize } from "./lexer.js";
import { nested, NestingLimitError } from "./nesting.js";
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
  const readings = at.trials.bothReadings;
  const outer = readings.deepest;
  readings.deepest = 0;
  try {
    return expansionEnd(at, dollar, found);
  } finally {
    readings.deepest = Math.max(outer, readings.deepest);
  }
}

/**
 * A body the guard's window cuts before its close is read whole once the lexer finds that close; when the lexer finds
 * none, or nests past the limit looking, the expansion is refused as unread.
 */
function expansionEnd(at: Reading, dollar: number, found: Token[][]): number {
  const cut = mathCutByWindow(at.src, dollar);
  const known = at.trials.ends.get(dollar);
  if (known === -1) return unfound(cut);
  if (known !== undefined) return withSubshellReading(at, dollar, checkedClose(at.src, dollar, known, cut), found, arithmeticTokens(at, dollar));
  const trial: Token[][] = [];
  const end = cut ? unreadPastLimit(() => arithmeticTrial(at, dollar, trial)) : arithmeticTrial(at, dollar, trial);
  at.trials.ends.set(dollar, end);
  if (end === -1) return unfound(cut);
  at.trials.arithmetic.set(dollar, trial);
  return withSubshellReading(at, dollar, checkedClose(at.src, dollar, end, cut), found, trial);
}

function unfound(cut: boolean): number {
  if (cut) throw unreadExpansion();
  return -1;
}

function checkedClose(src: string, dollar: number, end: number, cut: boolean): number {
  return cut ? refusingMisreadLongMath(src, dollar, end) : refusingMisreadMath(src, dollar, end);
}

function unreadPastLimit(find: () => number): number {
  try {
    return find();
  } catch (error) {
    throw error instanceof NestingLimitError ? unreadExpansion() : error;
  }
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
const PLAIN_PARAMETER = /\$\{(?:#?[A-Za-z_]\w*(?:\[(?:[@*]|\d+)\])?|[A-Za-z_]\w*:?[-=+][\w.]*)\}/g;
const BASE_NUMBER = /\b\d+#\w+/g;
const NESTED_EXPANSION = /\$[([]/;
const PLAIN_COMMAND = /^(?:[\w \t+\-*/%>=,.:]|<(?!<))*$/;
const INNERMOST_SPAN = /\$\(\(([^()`]*)\)\)|\$\(([^()`]*)\)|`([^`]*)`/g;

/**
 * Whether the body is plain math: nothing in it hides a paren from the arithmetic reading, so the shells read it
 * the same way. That takes only characters that hide nothing, a `${name}`, `${#name}`, `${#name[@]}` or
 * `${name:-word}`, a base number such as `16#ff` (a `#` inside a word starts no comment), brackets that balance and
 * parens that never close more than they opened. zsh reads an unbalanced `[` or `]` as a command, so those are not
 * plain. A nested `$(( ))` of plain math, or a `$( )` or backquote holding only plain command text (no quote,
 * backslash, `#`, paren, separator, newline or heredoc), cannot hide a paren either, so it counts as a name; any
 * other nested span is not plain. Every body that is not plain is read both ways or refused.
 */
function isPlainMath(body: string): boolean {
  return isPlainMathText(withPlainSpansFolded(body.replace(PLAIN_PARAMETER, "x").replace(BASE_NUMBER, "x")));
}

function withPlainSpansFolded(text: string): string {
  let outer = text;
  for (let folded = foldInnermostSpans(outer); folded !== outer; folded = foldInnermostSpans(outer)) outer = folded;
  return outer;
}

function foldInnermostSpans(text: string): string {
  return text.replace(INNERMOST_SPAN, (span, math?: string, command?: string, backquoted?: string) => {
    const plain = math === undefined ? PLAIN_COMMAND.test(command ?? backquoted ?? "") : isPlainMathText(math);
    return plain ? "x" : span;
  });
}

function isPlainMathText(text: string): boolean {
  if (!PLAIN_MATH.test(text) || NESTED_EXPANSION.test(text)) return false;
  let parens = 0;
  let brackets = 0;
  for (const c of text) {
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
 * Both readings of a span nested in another are costly to walk, so nesting past `MAX_BOTH_READINGS` is refused, even
 * through a heredoc body or a backquote, and with an error no arithmetic trial around it reads as a subshell.
 */
function withSubshellReading(at: Reading, dollar: number, end: number, found: Token[][], primary: Token[][]): number {
  found.push(...primary);
  if (isPlainMath(at.src.slice(dollar + 3, end - 1))) return end;
  const depth = bothReadingsDepth(at.trials, dollar);
  if (depth > MAX_BOTH_READINGS) throw new NestingLimitError("arithmetic read two ways nests too deep");
  let tokens = at.trials.subshells.get(dollar);
  if (tokens === undefined) {
    tokens = [lexSubshellReading(at, dollar)];
    at.trials.subshells.set(dollar, tokens);
  }
  found.push(...tokens);
  return end;
}

const MAX_BOTH_READINGS = 4;

/** How many spans read two ways nest at `dollar`, itself included, counting those enclosing it in whichever reading met it first. */
function bothReadingsDepth(trials: ArithTrials, dollar: number): number {
  const readings = trials.bothReadings;
  const depth = trials.depths.get(dollar) ?? Math.max(readings.deepest, readings.level) + 1;
  trials.depths.set(dollar, depth);
  readings.deepest = Math.max(readings.deepest, depth);
  return depth;
}

function lexSubshellReading(at: Reading, dollar: number): Token[] {
  const readings = at.trials.bothReadings;
  const outer = readings.level;
  readings.level = outer + 1;
  try {
    return lexNested(at.src, dollar + 2, at.trials, at.line).tokens;
  } finally {
    readings.level = outer;
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
