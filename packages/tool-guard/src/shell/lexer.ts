import { decodeAnsiC } from "./ansi-c.js";

export class ParseError extends Error {
  override name = "ParseError";
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

interface LexState {
  src: string;
  i: number;
  nested: boolean;
  depth: number;
  tokens: Token[];
  word: WordToken | null;
  heredocs: Array<{ token: RedirectToken; stripTabs: boolean }>;
  redirect: { token: RedirectToken; stripTabs: boolean } | null;
  /** Index of the `]` closing an assignment's subscript; blanks and operators before it stay in the word. */
  subscriptEnd: number;
}

const OPERATORS = ["&&", "||", ";;", "|&", "|", ";", "&", "(", ")", "\n"];
const REDIRECT_RE = /&>>?|<<<|<<-?|<>|>>|>&|<&|>\||>|</y;
const VARIABLE_RE = /[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-]/y;
const BRACED_NAME_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGNMENT_WORD_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[.*\])?\+?=/s;
const COMMAND_STARTS = new Set(["{", "then", "do", "else", "elif", "if", "while", "until", "!", "time"]);
/** Characters that keep their meaning inside a subscript: quotes, escapes and expansions. */
const SUBSCRIPT_ACTIVE = "\\'\"`$";

/** Splits a command string into words, operators, redirections and substitutions. Throws `ParseError`. */
export function tokenize(src: string): Token[] {
  const s = newState(src, 0, false);
  lex(s);
  return s.tokens;
}

function newState(src: string, i: number, nested: boolean): LexState {
  return { src, i, nested, depth: 0, tokens: [], word: null, heredocs: [], redirect: null, subscriptEnd: -1 };
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
  const reader = Object.hasOwn(READERS, c) ? READERS[c] : undefined;
  if (c === "$" || c === "`") ensureWord(s).unquotedExpansion = true;
  if (reader) return reader(s);
  if (c === "#" && !s.word) return skipComment(s);
  if (c === "&" && s.src[s.i + 1] === ">") return readRedirect(s);
  const op = OPERATORS.find((o) => s.src.startsWith(o, s.i));
  if (op) return readOperator(s, op);
  if (s.word?.quoted) s.word.spliced = true;
  appendChar(s, c);
}

/**
 * Bash reads `NAME[...]` through the matching `]` as one word, blanks included, when it stands where an
 * assignment may: `Y[ 0 ]=x git push` assigns element 0 and runs git. Anything else lexes as before.
 */
function markSubscript(s: LexState): void {
  const w = s.word;
  if (!w || w.quoted || w.dynamic || s.redirect || !IDENTIFIER_RE.test(w.value)) return;
  if (!atAssignmentPosition(s.tokens)) return;
  const close = matchingBracket(s.src, s.i);
  const after = close === -1 ? "" : s.src.slice(close + 1, close + 3);
  if (after.startsWith("=") || after === "+=") s.subscriptEnd = close;
}

/** True when only assignments, redirections or reserved words stand between the last operator and here. */
function atAssignmentPosition(tokens: Token[]): boolean {
  for (let k = tokens.length - 1; k >= 0; k--) {
    const t = tokens[k] as Token;
    if (t.type === "op") return t.value !== ";;";
    if (t.type === "subs") return false;
    if (t.type === "word" && !ASSIGNMENT_WORD_RE.test(t.value) && (t.quoted || !COMMAND_STARTS.has(t.value))) return false;
  }
  return true;
}

/** Index of the `]` matching the `[` at `open`, skipping quoted text; -1 when it never closes. */
function matchingBracket(src: string, open: number): number {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === "'") j = src.indexOf("'", j + 1);
    else if (c === '"') j = closingDoubleQuote(src, j);
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return j;
    if (j === -1) return -1;
  }
  return -1;
}

function closingDoubleQuote(src: string, open: number): number {
  for (let j = open + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === '"') return j;
  }
  return -1;
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
  if (op === "\n") readHeredocBodies(s);
}

function readHeredocBodies(s: LexState): void {
  for (const { token, stripTabs } of s.heredocs) {
    const delim = token.target?.value;
    let body = "";
    while (s.i < s.src.length) {
      const newline = s.src.indexOf("\n", s.i);
      const end = newline === -1 ? s.src.length : newline;
      const line = stripTabs ? s.src.slice(s.i, end).replace(/^\t+/, "") : s.src.slice(s.i, end);
      s.i = end + 1;
      if (line === delim) break;
      body += `${line}\n`;
    }
    token.body = body;
    if (!token.target?.quoted) token.subs = scanSubstitutions(body, 0, body.length);
  }
  s.heredocs = [];
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
  s.i = scanBacktick(s.src, s.i, w.subs) + 1;
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

function readSubstitution(s: LexState, start: number): Token[] {
  const inner = newState(s.src, start, true);
  lex(inner);
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
    w.subs.push(...scanSubstitutions(s.src, s.i + 2, i));
  }
  s.i = i + 1;
}

/** Token lists of every `$(...)` and backtick substitution in `src` between `from` and `to`. */
export function scanSubstitutions(src: string, from: number, to: number): Token[][] {
  const found: Token[][] = [];
  for (let j = from; j < to; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === "$" && src[j + 1] === "(" && src[j + 2] !== "(") {
      const inner = newState(src, j + 2, true);
      lex(inner);
      found.push(inner.tokens);
      j = inner.i;
    } else if (c === "`") j = scanBacktick(src, j, found);
  }
  return found;
}

function scanBacktick(src: string, start: number, found: Token[][]): number {
  let end = start + 1;
  while (end < src.length && src[end] !== "`") end += src[end] === "\\" ? 2 : 1;
  if (end >= src.length) throw new ParseError("unterminated `");
  found.push(tokenize(src.slice(start + 1, end).replace(/\\([`\\$])/g, "$1")));
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
