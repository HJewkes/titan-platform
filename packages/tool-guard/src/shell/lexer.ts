import { decodeAnsiC } from "./ansi-c.js";
import { type ArithTrials, cachedEnd, chargeTrial, newTrials, sameSpend, spent } from "./arith-trials.js";
import { readLineEnd } from "./procsub-heredoc.js";
import { assignmentSubscriptEnd } from "./subscript.js";

export class ParseError extends Error {
  override name = "ParseError";
}

/** A newline reached while a closed `$( )` or `<( )` still has a heredoc open, which bash 5 and bash 3.2 read differently. */
export class SplitParseError extends ParseError {
  override name = "SplitParseError";
}

/** A `$NAME` or `${NAME}` reference; `start` and `end` index into the word's `value`. */
export interface VarRef {
  name: string;
  start: number;
  end: number;
}

/**
 * One shell word with quotes removed. `dynamic` means its value is only known at run time;
 * `computed` means some of that comes from something other than a plain variable reference.
 */
export interface WordToken {
  type: "word";
  value: string;
  dynamic: boolean;
  quoted: boolean;
  /** Quotes or escapes split the word, or `$'...'` decoded it: `~/".x"`, `.n''x`, `.n\x`. */
  spliced: boolean;
  computed: boolean;
  /** A `$` or backtick expansion sits outside double quotes, so it word-splits even when other parts are quoted. */
  unquotedExpansion?: true;
  refs: VarRef[];
  /** Token lists of command substitutions, which run even when quoted. */
  subs: Token[][];
  /** The text before literal variables were expanded into it; absent when nothing was expanded. */
  typed?: string;
  /** Set on a word variable tracking adds itself, never by the lexer; only such a word can assign a hidden slot. */
  hidden?: true;
}

export interface OpToken {
  type: "op";
  value: string;
}

/** Process substitutions, `<(...)` and `>(...)`. */
export interface SubsToken {
  type: "subs";
  subs: Token[][];
}

/** `target` is the word after the operator; for a heredoc it is the delimiter and `body` is the text. */
export interface RedirectToken {
  type: "redirect";
  op: string;
  fd: string | null;
  target: WordToken | null;
  body: string | null;
  /** Command substitutions in an unquoted heredoc body, which the shell runs before the command. */
  subs: Token[][];
}

export type Token = WordToken | OpToken | SubsToken | RedirectToken;

export interface LexState {
  src: string;
  i: number;
  nested: boolean;
  depth: number;
  tokens: Token[];
  word: WordToken | null;
  heredocs: Array<{ token: RedirectToken; stripTabs: boolean }>;
  /** A `$( )` or `<( )` closed on this line with a heredoc still open. */
  leftOpen: boolean;
  redirect: { token: RedirectToken; stripTabs: boolean } | null;
  /** Index of the `]` closing an assignment's subscript; blanks and operators before it stay in the word. */
  subscriptEnd: number;
  /** Index of the `))` closing an arithmetic command; before it `<<` is a shift and `#` no comment. */
  arithEnd: number;
  trials: ArithTrials;
}

const OPERATORS = ["&&", "||", ";;", "|&", "|", ";", "&", "(", ")", "\n"];
const REDIRECT_RE = /&>>?|<<<|<<-?|<>|>>|>&|<&|>\||>|</y;
const VARIABLE_RE = /[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-]/y;
const BRACED_NAME_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Characters that keep their meaning inside a subscript: quotes, escapes and expansions. */
const SUBSCRIPT_ACTIVE = "\\'\"`$";

/** Splits a command string into words, operators, redirections and substitutions. Throws `ParseError`. */
export function tokenize(src: string, trials = newTrials(src)): Token[] {
  const s = newState(src, 0, false, trials);
  lex(s);
  return s.tokens;
}

function newState(src: string, i: number, nested: boolean, trials: ArithTrials): LexState {
  return { src, i, nested, depth: 0, tokens: [], word: null, heredocs: [], leftOpen: false, redirect: null, subscriptEnd: -1, arithEnd: -1, trials };
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
  if (c === "(" && s.src[s.i + 1] === "(" && !s.word && s.i > s.arithEnd) s.arithEnd = cachedEnd(s.trials, s.i, () => arithmeticEnd(s));
  if (s.i < s.arithEnd && s.src.startsWith("<<", s.i)) return appendShift(s);
  const reader = Object.hasOwn(READERS, c) ? READERS[c] : undefined;
  if (c === "$" || c === "`") ensureWord(s).unquotedExpansion = true;
  if (reader) return reader(s);
  if (c === "#" && !s.word && s.i >= s.arithEnd) return skipComment(s);
  if (c === "&" && s.src[s.i + 1] === ">") return readRedirect(s);
  const op = OPERATORS.find((o) => s.src.startsWith(o, s.i));
  if (op) return readOperator(s, op);
  if (s.word?.quoted) s.word.spliced = true;
  appendChar(s, c);
}

function markSubscript(s: LexState): void {
  const w = s.word;
  if (!w || w.quoted || w.dynamic || s.redirect || !IDENTIFIER_RE.test(w.value)) return;
  s.subscriptEnd = assignmentSubscriptEnd(s.src, s.i, s.tokens);
}

/**
 * Index of the `))` closing the `((` at `s.i`, or -1 when bash reads nested subshells instead:
 * like bash, it reads to the `)` matching the first `(` and wants another `)` right after it.
 * A trial lex with every `<<` a shift finds that `)` through the same quote readers; it fails
 * closed once the source's trials have spent their budget.
 */
function arithmeticEnd(s: LexState): number {
  const trial = newState(s.src, s.i + 2, true, s.trials);
  trial.arithEnd = Number.POSITIVE_INFINITY;
  let reached = s.src.length;
  try {
    lex(trial);
    reached = trial.i;
  } catch (error) {
    if (!(error instanceof ParseError) || spent(s.trials)) throw error;
  }
  if (!chargeTrial(s.trials, reached - s.i)) throw new ParseError("arithmetic command too costly to scan");
  return reached < s.src.length && s.src[reached + 1] === ")" ? reached : -1;
}

function appendShift(s: LexState): void {
  ensureWord(s).value += "<<";
  s.i += 2;
}

function readBlank(s: LexState): void {
  endWord(s);
  s.i++;
}

function ensureWord(s: LexState): WordToken {
  s.word ??= { type: "word", value: "", dynamic: false, quoted: false, spliced: false, computed: false, refs: [], subs: [] };
  return s.word;
}

function appendChar(s: LexState, c: string): void {
  ensureWord(s).value += c;
  s.i++;
}

function endWord(s: LexState): void {
  const w = s.word;
  if (!w) return;
  s.word = null;
  const pending = s.redirect;
  s.redirect = null;
  if (!pending) {
    s.tokens.push(w);
    return;
  }
  pending.token.target = w;
  if (pending.token.body !== null) s.heredocs.push(pending);
}

function readOperator(s: LexState, op: string): void {
  endWord(s);
  s.i += op.length;
  if (op === "(") s.depth++;
  if (op === ")") s.depth--;
  s.tokens.push({ type: "op", value: op });
  if (op === "\n") readLineEnd(s);
}

function readEscape(s: LexState): void {
  const next = s.src[s.i + 1];
  s.i += 2;
  if (next !== undefined && next !== "\n") {
    const w = ensureWord(s);
    w.value += next;
    w.quoted = true;
    w.spliced = true;
  }
}

function readSingle(s: LexState): void {
  const end = s.src.indexOf("'", s.i + 1);
  if (end === -1) throw new ParseError("unterminated '");
  const w = markQuoted(ensureWord(s));
  w.value += s.src.slice(s.i + 1, end);
  s.i = end + 1;
}

/** A quoted part after other text splits the word. */
function markQuoted(w: WordToken): WordToken {
  if (w.value !== "") w.spliced = true;
  w.quoted = true;
  return w;
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
    } else if (c === "$" && next !== "'") readDollar(s);
    else if (c === "`") readBacktick(s);
    else appendChar(s, c);
  }
  s.i++;
}

function readBacktick(s: LexState): void {
  const w = markComputed(ensureWord(s));
  s.i = scanBacktick(s.src, s.i, w.subs, s.trials) + 1;
}

function markComputed(w: WordToken): WordToken {
  w.dynamic = true;
  w.computed = true;
  return w;
}

function readDollar(s: LexState): void {
  const next = s.src[s.i + 1];
  const w = ensureWord(s);
  if (next === "(" && s.src[s.i + 2] === "(") return readBalanced(s, w, "(", ")");
  if (next === "(") return pushSubstitution(s, w, s.i + 2);
  if (next === "{") return readBalanced(s, w, "{", "}");
  if (next === "'") return readAnsiC(s, w);
  VARIABLE_RE.lastIndex = s.i + 1;
  const name = VARIABLE_RE.exec(s.src)?.[0];
  if (!name) return appendChar(s, "$");
  pushRef(w, name, `$${name}`);
  s.i += 1 + name.length;
}

function pushRef(w: WordToken, name: string, text: string): void {
  w.dynamic = true;
  w.refs.push({ name, start: w.value.length, end: w.value.length + text.length });
  w.value += text;
}

/** Every substitution on a line is lexed here, so a heredoc it leaves open stays pending on `line`, where bash 5 reads its body. */
function lexNested(src: string, start: number, trials: ArithTrials, line: LexState | null): LexState {
  const inner = newState(src, start, true, trials);
  lex(inner);
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
  w.subs.push(readSubstitution(s, start));
}

function readBalanced(s: LexState, w: WordToken, open: string, close: string): void {
  let depth = 0;
  let i = s.i + 1;
  for (; i < s.src.length; i++) {
    if (s.src[i] === open) depth++;
    if (s.src[i] === close && --depth === 0) break;
  }
  if (i >= s.src.length) throw new ParseError(`unterminated $${open}`);
  const text = s.src.slice(s.i, i + 1);
  const name = BRACED_NAME_RE.exec(text)?.[1];
  if (name) pushRef(w, name, text);
  else {
    markComputed(w).value += text;
    w.subs.push(...scanSubstitutions(s.src, s.i + 2, i, s.trials, { line: s, procsubs: open === "{" }));
  }
  s.i = i + 1;
}

/** Token lists of every substitution in `src` between `from` and `to`; `at` is the line they sit on, null in a heredoc body. */
export function scanSubstitutions(src: string, from: number, to: number, trials = newTrials(src), at: { line: LexState; procsubs: boolean } | null = null): Token[][] {
  const found: Token[][] = [];
  for (let j = from; j < to; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (opensSubstitution(src, j, at?.procsubs === true)) {
      const inner = lexNested(src, j + 2, trials, at?.line ?? null);
      found.push(inner.tokens);
      j = inner.i;
    } else if (c === "`") j = scanBacktick(src, j, found, trials);
  }
  return found;
}

/** `<(` and `>(` substitute only where `procsubs` says so, as in `${...}`; in `$((...))` they compare. */
function opensSubstitution(src: string, j: number, procsubs: boolean): boolean {
  if (src[j + 1] !== "(") return false;
  if (src[j] === "$") return src[j + 2] !== "(";
  return procsubs && (src[j] === "<" || src[j] === ">");
}

function scanBacktick(src: string, start: number, found: Token[][], trials: ArithTrials): number {
  let end = start + 1;
  while (end < src.length && src[end] !== "`") end += src[end] === "\\" ? 2 : 1;
  if (end >= src.length) throw new ParseError("unterminated `");
  found.push(tokenize(src.slice(start + 1, end).replace(/\\([`\\$])/g, "$1"), sameSpend(trials)));
  return end;
}

function readAnsiC(s: LexState, w: WordToken): void {
  let end = s.i + 2;
  while (end < s.src.length && s.src[end] !== "'") end += s.src[end] === "\\" ? 2 : 1;
  if (end >= s.src.length) throw new ParseError("unterminated $'");
  w.value += decodeAnsiC(s.src.slice(s.i + 2, end));
  w.quoted = true;
  w.spliced = true;
  s.i = end + 1;
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
  REDIRECT_RE.lastIndex = s.i;
  const op = (REDIRECT_RE.exec(s.src) as RegExpExecArray)[0];
  s.i += op.length;
  if ((op === "<" || op === ">") && s.src[s.i] === "(") {
    s.tokens.push({ type: "subs", subs: [readSubstitution(s, s.i + 1)] });
    return;
  }
  const heredoc = op === "<<" || op === "<<-";
  const token: RedirectToken = { type: "redirect", op, fd, target: null, body: heredoc ? "" : null, subs: [] };
  s.tokens.push(token);
  s.redirect = { token, stripTabs: op === "<<-" };
}
