import { type ArithTrials, cachedEnd, chargeTrial, newTrials, sameSpend, spent } from "./arith-trials.js";
import { backtickEnd, balancedEnd, type DollarOpener, dollarOpener, type NestedReaders, QUOTED_LITERAL_OPENERS } from "./balanced.js";
import { dropJoins, joinedDollar, nextAfter, pastJoins, readAhead } from "./joins.js";
import { nested } from "./nesting.js";
import { ParseError, refusingAs, SplitParseError } from "./parse-error.js";
import { readLineEnd } from "./procsub-heredoc.js";
import { assignmentSubscriptEnd, isNameSoFar } from "./subscript.js";
import type { LexState, RedirectToken, Token, WordToken } from "./tokens.js";
import { appendChar, endWord, ensureWord, markComputed, markCut, markQuoted, pushRef, readAnsiC, readEscape, readSingle, variableName } from "./word-build.js";

export { ParseError, SplitParseError } from "./parse-error.js";
export type { LexState, OpToken, RedirectToken, SubsToken, Token, VarRef, WordToken } from "./tokens.js";

const OPERATORS = ["&&", "||", ";;", "|&", "|", ";", "&", "(", ")", "\n"];
const REDIRECT_RE = /&>>?|<<<|<<-?|<>|>>|>&|<&|>\||>|</y;
const BRACED_NAME_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
/** Characters that keep their meaning inside a subscript: quotes, escapes and expansions. */
const SUBSCRIPT_ACTIVE = "\\'\"`$";

/** Splits a command string into words, operators, redirections and substitutions. Throws `ParseError`. */
export function tokenize(src: string, trials = newTrials(src)): Token[] {
  const s = newState(src, 0, false, trials);
  lex(s);
  return s.tokens;
}

function newState(src: string, i: number, nested: boolean, trials: ArithTrials): LexState {
  return { src, i, nested, depth: 0, tokens: [], word: null, heredocs: [], leftOpen: false, redirect: null, subscriptEnd: -1, arithEnd: -1, wholeEnd: -1, trials };
}

function lex(s: LexState): void {
  while (s.i < s.src.length) {
    if (s.nested && s.depth === 0 && s.src[s.i] === ")") return endWord(s);
    step(s);
  }
  if (s.nested) throw new ParseError("unterminated $(");
  endWord(s);
}

const READERS: Record<string, (s: LexState) => void> = {
  " ": readBlank,
  "\t": readBlank,
  "\r": readBlank,
  "\\": readEscape,
  "'": readSingle,
  '"': readDouble,
  "`": readBacktick,
  $: readDollar,
  "<": readRedirect,
  ">": readRedirect,
};

function step(s: LexState): void {
  const c = s.src[s.i] as string;
  if (s.i < s.subscriptEnd && !SUBSCRIPT_ACTIVE.includes(c)) return appendChar(s, c);
  if (c === "[") markSubscript(s);
  const ahead = readAhead(s.src, s.i, 3);
  const end = (length: number) => ahead.ends[length - 1] ?? s.src.length;
  if (c === "(" && ahead.text[1] === "(" && !s.word && s.i > s.arithEnd) markDoubleParen(s, end(2));
  if (s.i < s.arithEnd && ahead.text.startsWith("<<")) return appendShift(s, end(2));
  const reader = Object.hasOwn(READERS, c) ? READERS[c] : undefined;
  if (c === "$" || c === "`") ensureWord(s).unquotedExpansion = true;
  if (reader) return reader(s);
  if (c === "#" && !s.word && s.i >= s.arithEnd) return skipComment(s);
  if (c === "&" && ahead.text[1] === ">") return readRedirect(s);
  const op = OPERATORS.find((o) => ahead.text.startsWith(o));
  if (op) return readOperator(s, op, end(op.length));
  if (s.word?.quoted) s.word.spliced = true;
  appendChar(s, c);
}

function markSubscript(s: LexState): void {
  const w = s.word;
  if (!w || w.quoted || w.dynamic || s.redirect || !isNameSoFar(w)) return;
  s.subscriptEnd = assignmentSubscriptEnd(s.src, s.i, s.tokens);
}

/**
 * Like bash, reads the `((` at `s.i` whole to the `)` matching its second `(`: an arithmetic command
 * when another `)` follows, and otherwise nested subshells that bash lexes again from that text.
 */
function markDoubleParen(s: LexState, body: number): void {
  const close = cachedEnd(s.trials, s.i, () => doubleParenClose(s, body));
  s.arithEnd = close !== -1 && s.src[nextAfter(s.src, close)] === ")" ? close : -1;
  s.wholeEnd = Math.max(s.wholeEnd, close);
}

/**
 * Index of the `)` matching the second `(` of the `((` at `s.i`, or -1 when none closes it.
 * A trial lex with every `<<` a shift finds that `)` through the same quote readers; it fails
 * closed once the source's trials have spent their budget.
 */
function doubleParenClose(s: LexState, body: number): number {
  const trial = newState(s.src, body, true, s.trials);
  trial.arithEnd = Number.POSITIVE_INFINITY;
  let reached = s.src.length;
  try {
    lex(trial);
    reached = trial.i;
  } catch (error) {
    if (!(error instanceof ParseError) || spent(s.trials)) throw error;
  }
  if (!chargeTrial(s.trials, reached - s.i)) throw new ParseError("arithmetic command too costly to scan");
  return reached < s.src.length ? reached : -1;
}

function appendShift(s: LexState, end: number): void {
  ensureWord(s).value += "<<";
  s.i = end;
}

function readBlank(s: LexState): void {
  endWord(s);
  s.i++;
}

/** A newline bash read inside a `((` span, arithmetic or reparsed as subshells, is not a line end and starts no heredoc body. */
function readOperator(s: LexState, op: string, end: number): void {
  const inWholeSpan = s.i < s.wholeEnd;
  endWord(s);
  s.i = end;
  if (op === "(") s.depth++;
  if (op === ")") s.depth--;
  s.tokens.push({ type: "op", value: op });
  if (op === "\n" && !inWholeSpan) readLineEnd(s);
}

function readDouble(s: LexState): void {
  const w = markQuoted(ensureWord(s));
  s.i++;
  while (s.src[s.i] !== '"') {
    if (s.i >= s.src.length) throw new ParseError('unterminated "');
    const c = s.src[s.i] as string;
    const next = s.src[s.i + 1];
    if (c === "\\" && next !== undefined && '$`"\\\n'.includes(next)) {
      if (next !== "\n") w.value += next;
      s.i += 2;
    } else if (c === "$" && !QUOTED_LITERAL_OPENERS.includes(s.src[joinedDollar(s.src, s.i) + 1] ?? "")) readDollar(s);
    else if (c === "`") readBacktick(s);
    else appendChar(s, c);
  }
  s.i++;
}

function readBacktick(s: LexState): void {
  const w = markComputed(ensureWord(s));
  markCut(w);
  s.i = scanBacktick(s.src, s.i, w.subs, s.trials) + 1;
}

const DOLLAR_READERS: Record<DollarOpener, (s: LexState, w: WordToken) => void> = {
  pid: readVariable,
  braced: (s, w) => refusingAs("unclosed-expansion", () => readBraced(s, w)),
  bracket: (s, w) => refusingAs("unclosed-expansion", () => readBracketArithmetic(s, w)),
  paren: (s, w) => (s.src[nextAfter(s.src, s.i + 1)] === "(" ? refusingAs("unclosed-expansion", () => readArithmetic(s, w)) : pushSubstitution(s, w, s.i + 2)),
  "ansi-c": readAnsiC,
  locale: readLocale,
};

function readDollar(s: LexState): void {
  const w = ensureWord(s);
  s.i = joinedDollar(s.src, s.i);
  const opener = dollarOpener(s.src, s.i);
  if (opener) return DOLLAR_READERS[opener](s, w);
  readVariable(s, w);
}

function readVariable(s: LexState, w: WordToken): void {
  const read = variableName(s.src, s.i + 1);
  if (!read) return appendChar(s, "$");
  pushRef(w, read.name, `$${read.name}`);
  s.i = read.end;
}

/** Every substitution on a line is lexed here, so a heredoc it leaves open stays pending on `line`, where bash 5 reads its body. */
function lexNested(src: string, start: number, trials: ArithTrials, line: LexState | null): LexState {
  const inner = newState(src, start, true, trials);
  nested(trials.nesting, () => lex(inner));
  if (line && (inner.leftOpen || inner.heredocs.length > 0)) line.leftOpen = true;
  return inner;
}

function readSubstitution(s: LexState, start: number): Token[] {
  const inner = lexNested(s.src, start, s.trials, s);
  s.i = inner.i + 1;
  return inner.tokens;
}

function pushSubstitution(s: LexState, w: WordToken, start: number): void {
  markComputed(w);
  markCut(w);
  w.subs.push(readSubstitution(s, start));
}

/** Where substitutions are lexed: `line` is null in a heredoc body or a quoted span, which has no line to leave a heredoc open on. */
interface Reading {
  src: string;
  trials: ArithTrials;
  line: LexState | null;
}

function lineReading(s: LexState): Reading {
  return { src: s.src, trials: s.trials, line: s };
}

/** Reads a `${ }`; every substitution in it is lexed once, as the brace matching meets it. */
function readBraced(s: LexState, w: WordToken): void {
  const found: Token[][] = [];
  const end = balancedEnd(s.src, s.i + 1, nestedReaders(lineReading(s), found));
  const text = dollarText(s, end);
  const name = BRACED_NAME_RE.exec(text)?.[1];
  if (name) pushRef(w, name, text);
  else {
    markComputed(w).value += text;
    w.subs.push(...found);
  }
  s.i = end + 1;
}

function readArithmetic(s: LexState, w: WordToken): void {
  const found: Token[][] = [];
  const end = arithmeticExpansionEnd(lineReading(s), s.i, found);
  if (end === -1) return pushSubstitution(s, w, s.i + 2);
  markComputed(w).value += dollarText(s, end);
  w.subs.push(...found);
  s.i = end + 1;
}

/** The expansion ending at `end`, spelled without the backslash-newlines bash dropped after its `$`. */
function dollarText(s: LexState, end: number): string {
  return dropJoins(`$${s.src.slice(s.i + 1, end + 1)}`);
}

/** Reads a `$[ ]`, bash's older spelling of `$(( ))`, through the same matching as `${ }`. */
function readBracketArithmetic(s: LexState, w: WordToken): void {
  const found: Token[][] = [];
  const end = balancedEnd(s.src, s.i + 1, nestedReaders(lineReading(s), found));
  markComputed(w).value += dollarText(s, end);
  w.subs.push(...found);
  s.i = end + 1;
}

/**
 * Last index of the `$((` at `dollar` when bash reads arithmetic, or -1 when it reads `$( (…) … )`:
 * as `arithmeticEnd` does for `((`, the `)` matching the second `(` must be followed by another.
 * Each decision is kept per position, so a subshell reading that lexes the text again stays polynomial.
 */
function arithmeticExpansionEnd(at: Reading, dollar: number, found: Token[][]): number {
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

function nestedReaders(at: Reading, found: Token[][]): NestedReaders {
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

function scanBacktick(src: string, start: number, found: Token[][], trials: ArithTrials): number {
  const end = backtickEnd(src, start);
  found.push(nested(trials.nesting, () => tokenize(src.slice(start + 1, end).replace(/\\([`\\$])/g, "$1"), sameSpend(trials))));
  return end;
}

/** A `$"…"` is translated through the locale's message catalog at run time, so its value is not the text. */
function readLocale(s: LexState, w: WordToken): void {
  markComputed(w);
  s.i++;
  readDouble(s);
}

function skipComment(s: LexState): void {
  const newline = s.src.indexOf("\n", s.i);
  s.i = newline === -1 ? s.src.length : newline;
}

function readRedirect(s: LexState): void {
  const w = s.word;
  let fd: string | null = null;
  if (w && !w.quoted && !w.dynamic && /^\d+$/.test(w.value)) {
    fd = w.value;
    s.word = null;
  } else endWord(s);
  const ahead = readAhead(s.src, s.i, 3);
  REDIRECT_RE.lastIndex = 0;
  const op = (REDIRECT_RE.exec(ahead.text) as RegExpExecArray)[0];
  s.i = ahead.ends[op.length - 1] ?? s.src.length;
  const paren = pastJoins(s.src, s.i);
  if ((op === "<" || op === ">") && s.src[paren] === "(") {
    s.tokens.push({ type: "subs", subs: [readSubstitution(s, paren + 1)] });
    return;
  }
  const heredoc = op === "<<" || op === "<<-";
  const token: RedirectToken = { type: "redirect", op, fd, target: null, body: heredoc ? "" : null, subs: [] };
  s.tokens.push(token);
  s.redirect = { token, stripTabs: op === "<<-" };
}
