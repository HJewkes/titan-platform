import { type ArithTrials, cachedEnd, chargeTrial, newTrials, spent } from "./arith-trials.js";
import { balancedEnd, type DollarOpener, dollarOpener, QUOTED_LITERAL_OPENERS, refuseValueRun } from "./balanced.js";
import { dropJoins, joinedDollar, nextAfter, pastJoins, readAhead } from "./joins.js";
import { inConditional, inJoiningConditional, inOpenCase, newRegexScan, noteParen, refuseRedirect } from "./compound.js";
import { nested } from "./nesting.js";
import { ParseError, refusingAs } from "./parse-error.js";
import { arithmeticExpansionEnd, lineReading, nestedReaders, scanBacktick } from "./nested-reading.js";
import { readLineEnd } from "./procsub-heredoc.js";
import { assignmentSubscriptEnd, looseSubscriptEnd, isNameSoFar, wordStartSubscriptEnd } from "./subscript.js";
import type { LexState, RedirectToken, Token, WordToken } from "./tokens.js";
import { readAnsiInArith } from "./arith-ansi.js";
import { appendChar, endWord, ensureWord, markComputed, markCut, markQuoted, pushRef, readAnsiC, readEscape, readSingle, variableName } from "./word-build.js";

export { ParseError, SplitParseError } from "./parse-error.js";
export { scanSubstitutions } from "./substitutions.js";
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
  return { src, i, nested, depth: 0, tokens: [], word: null, heredocs: [], leftOpen: false, redirect: null, subscriptEnd: -1, looseSubscriptEnd: -1, arithOutsideLoose: true, arithEnd: -1, arithOpen: -1, wholeEnd: -1, compoundDepth: -1, caseWords: false, regex: newRegexScan(), trials };
}

function lex(s: LexState): void {
  while (s.i < s.src.length) {
    if (s.nested && s.depth === 0 && s.src[s.i] === ")" && closesSubstitution(s)) return endWord(s);
    step(s);
  }
  if (s.nested) throw new ParseError("unterminated $(");
  endWord(s);
}

/** A `)` left unmatched inside an open `case` ends a pattern, as `a)` in `$(case x in a) cmd;; esac)`; only one after `esac` closes. */
function closesSubstitution(s: LexState): boolean {
  endWord(s);
  return !inOpenCase(s);
}

const READERS: Record<string, (s: LexState) => void> = {
  " ": readBlank,
  "\t": readBlank,
  "\\": readEscape,
  "'": readSingleOrArith,
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
  if (c === "(" && ahead.text[1] === "(" && !s.word && s.i > s.arithEnd) startArithmetic(s, end(2));
  if (s.i < s.looseSubscriptEnd && !arithmeticEncloses(s)) refuseHidingOpener(s, c, ahead.text);
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

/**
 * Bash also reads a `[` that starts a word through its `]` as one word inside `NAME=( … )` and `NAME+=( … )`. Rather
 * than predict those positions too, every word-start `[` opens a loose span; `[ x ] # c` and `[[ … ]] # c` keep their
 * comment, which falls after the matching `]`.
 */
function markSubscript(s: LexState): void {
  const w = s.word;
  if (!w) {
    s.looseSubscriptEnd = Math.max(s.looseSubscriptEnd, wordStartSubscriptEnd(s.src, s.i));
    return;
  }
  if (w.quoted || w.dynamic || s.redirect || !isNameSoFar(w)) return;
  s.subscriptEnd = assignmentSubscriptEnd(s.src, s.i, s.tokens);
  // A `[` nested in a span closes before the outer `]`, so it must not shorten the span.
  if (s.subscriptEnd === -1) s.looseSubscriptEnd = Math.max(s.looseSubscriptEnd, looseSubscriptEnd(s.src, s.i, s.tokens));
}

/** Whether the arithmetic begins outside every loose span is settled here, once: no later `[` may requalify it. */
function startArithmetic(s: LexState, body: number): void {
  s.arithOutsideLoose = s.i >= s.looseSubscriptEnd;
  markDoubleParen(s, body);
  s.arithOpen = s.arithEnd === -1 ? -1 : s.i;
}

/**
 * Whether the current character sits in arithmetic begun outside every loose span, as in `((a[1<<2]))`, where bash
 * reads `<<` as a shift and a newline as a blank in both readings. A `((` opened inside a loose span is only text to
 * bash's joined reading, so it switches nothing off, in that span or any span after it.
 */
function arithmeticEncloses(s: LexState): boolean {
  return s.i < s.arithEnd && s.arithOutsideLoose;
}

/**
 * Every character the split reading would take to read past the current token: a comment, a heredoc opener, or a
 * newline while a heredoc waits for its body. Joined, bash reads each as text and runs what the split reading hides,
 * such as a `${` funsub or the line after the `]`; split, the comment or body is real and hides what the joined
 * reading shows. No single reading shows every command bash may run, so the line is refused.
 */
function refuseHidingOpener(s: LexState, c: string, ahead: string): void {
  const opensBody = c === "\n" && s.heredocs.length > 0;
  if ((c === "#" && !s.word) || ahead.startsWith("<<") || opensBody) throw new ParseError("a subscript bash may join or split holds a comment, heredoc or heredoc body");
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

function appendWord(s: LexState, text: string, end: number): void {
  ensureWord(s).value = text;
  endWord(s);
  s.i = end;
}

function readBlank(s: LexState): void {
  endWord(s);
  s.i++;
}

/** A newline bash read inside a `((` span, arithmetic or reparsed as subshells, is not a line end and starts no heredoc body. */
function readOperator(s: LexState, op: string, end: number): void {
  const inWholeSpan = s.i < s.wholeEnd;
  const start = s.i;
  const glued = op === "(" && s.word ? s.word.value.slice(-1) : null;
  endWord(s);
  // A glued `]]` is a pending word until it ends, so the `[[` is judged only after `endWord`.
  if ((op === "&&" || op === "||") && inJoiningConditional(s)) return appendWord(s, op, end);
  noteParen(s, op, glued);
  s.i = end;
  s.tokens.push(op === "(" && start === s.arithOpen ? { type: "op", value: op, arith: true } : { type: "op", value: op });
  if (op === "\n" && !inWholeSpan) readLineEnd(s);
}

/** bash and zsh expand an arithmetic body as if double-quoted, so its single quotes are literal and `$(cmd)` still runs. */
function readSingleOrArith(s: LexState): void {
  if (s.i >= s.arithEnd || s.arithEnd === Number.POSITIVE_INFINITY) return readSingle(s);
  readQuoted(s, "'");
  // bash finds the span's end with the quote taken whole, so a substitution reaching past it reads two ways.
  if (s.i > s.arithEnd) throw new ParseError("a substitution in arithmetic runs past the end bash finds for it");
}

function readDouble(s: LexState): void {
  readQuoted(s, '"');
}

function readQuoted(s: LexState, close: string): void {
  const w = markQuoted(ensureWord(s));
  s.i++;
  while (s.src[s.i] !== close) {
    if (s.i >= s.src.length) throw new ParseError(`unterminated ${close}`);
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
  "ansi-c": (s, w) => (s.i < s.arithEnd ? readAnsiInArith(s, w) : readAnsiC(s, w)),
  locale: readLocale,
};

function readDollar(s: LexState): void {
  const w = ensureWord(s);
  s.i = joinedDollar(s.src, s.i);
  refuseValueRun(s.src, s.i);
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
export function lexNested(src: string, start: number, trials: ArithTrials, line: LexState | null): LexState {
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
    const awaited = s.redirect !== null && s.tokens.at(-1) === s.redirect.token;
    s.tokens.push({ type: "subs", subs: [readSubstitution(s, paren + 1)], ...(awaited ? { awaited: true as const } : {}) });
    return;
  }
  refuseRedirect(s, op);
  const named = fd === null ? namedFdWord(s, w) : null;
  const heredoc = op === "<<" || op === "<<-";
  const token: RedirectToken = { type: "redirect", op, fd, target: null, body: heredoc ? "" : null, subs: [], ...(named ? { named: named.value } : {}) };
  s.tokens.push(token);
  s.redirect = { token, stripTabs: op === "<<-" };
}

/** bash's `{name}` or `{name[i]}`, and zsh's `{name}`, before a redirect: the shell stores the fd it opens there. */
export const NAMED_FD_RE = /^\{([A-Za-z_]\w*)(\[.*\])?\}$/;

/**
 * The `{name}` word bash and zsh read as a named descriptor: glued to the operator, or for zsh a space before it, plain.
 * Dash, and bash a space apart, keep it a word, so it stays in the tokens marked `namedFd` for the walk to read both ways.
 */
function namedFdWord(s: LexState, glued: WordToken | null): WordToken | null {
  const last = s.tokens.at(-1);
  if (s.i < s.arithEnd || last?.type !== "word" || (glued !== null && glued !== last)) return null;
  const match = !last.quoted && !last.spliced ? NAMED_FD_RE.exec(last.value) : null;
  if (!match || (glued === null && match[2] !== undefined) || inConditional(s)) return null;
  last.namedFd = glued === null ? "spaced" : "glued";
  return last;
}
