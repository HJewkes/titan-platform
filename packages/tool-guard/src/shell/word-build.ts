import { decodeAnsiC } from "./ansi-c.js";
import { CODE_TEXT_RE, refuseCodeInArithmeticValue } from "./arith-operand.js";
import { ansiCEnd } from "./balanced.js";
import { pastJoins } from "./joins.js";
import { ParseError } from "./parse-error.js";
import type { LexState, WordToken } from "./tokens.js";

const VARIABLE_RE = /[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-]/y;
const NAME_TAIL_RE = /[A-Za-z0-9_]+/y;

export function ensureWord(s: LexState): WordToken {
  s.word ??= { type: "word", value: "", dynamic: false, quoted: false, spliced: false, computed: false, refs: [], subs: [] };
  return s.word;
}

export function appendChar(s: LexState, c: string): void {
  appendLiteral(ensureWord(s), c);
  s.i++;
}

/**
 * Appends text the word spells out itself, as a quote, an escape or a character does, rather than text an expansion
 * stands for. A `$(` or backtick that lands in the value this way is code text, which bash evaluates wherever it reads
 * the value as arithmetic.
 */
export function appendLiteral(w: WordToken, text: string): void {
  // Reading the value back would flatten the string being built on every character, so only the new text is tested.
  const joinsDollar = (text.startsWith("(") || text.startsWith("{")) && w.value.endsWith("$");
  w.value += text;
  if (joinsDollar || CODE_TEXT_RE.test(text)) w.codeText = true;
}

export function endWord(s: LexState): void {
  const w = s.word;
  if (!w) return;
  s.word = null;
  const pending = s.redirect;
  s.redirect = null;
  if (!pending) {
    refuseCodeInArithmeticValue(s, w);
    if (w.value === "case" || w.value === "esac") s.caseWords = true;
    s.tokens.push(w);
    return;
  }
  pending.token.target = w;
  if (pending.token.body !== null) s.heredocs.push(pending);
}

/** A quoted part after other text splits the word. */
export function markQuoted(w: WordToken): WordToken {
  if (w.value !== "") w.spliced = true;
  w.quoted = true;
  return w;
}

export function markCut(w: WordToken): void {
  (w.cuts ??= []).push({ at: w.value.length, sub: w.subs.length });
}

export function markComputed(w: WordToken): WordToken {
  w.dynamic = true;
  w.computed = true;
  return w;
}

export function pushRef(w: WordToken, name: string, text: string): void {
  w.dynamic = true;
  w.refs.push({ name, start: w.value.length, end: w.value.length + text.length });
  w.value += text;
}

export function readEscape(s: LexState): void {
  const next = s.src[s.i + 1];
  s.i += 2;
  if (next !== undefined && next !== "\n") {
    const w = ensureWord(s);
    appendLiteral(w, next);
    w.quoted = true;
    w.spliced = true;
  }
}

export function readSingle(s: LexState): void {
  const end = s.src.indexOf("'", s.i + 1);
  if (end === -1) throw new ParseError("unterminated '");
  const w = markQuoted(ensureWord(s));
  appendLiteral(w, s.src.slice(s.i + 1, end));
  s.i = end + 1;
}

export function readAnsiC(s: LexState, w: WordToken): void {
  const end = ansiCEnd(s.src, s.i + 1);
  appendLiteral(w, decodeAnsiC(s.src.slice(s.i + 2, end)));
  w.quoted = true;
  w.spliced = true;
  s.i = end + 1;
}

/** The name a `$` at `from - 1` expands and where it ends; a backslash-newline inside a name joins it, so `$a\<NL>b` reads `$ab`. */
export function variableName(src: string, from: number): { name: string; end: number } | null {
  VARIABLE_RE.lastIndex = from;
  let name = VARIABLE_RE.exec(src)?.[0];
  if (name === undefined) return null;
  let end = from + name.length;
  while (/^[A-Za-z_]/.test(name) && pastJoins(src, end) > end) {
    NAME_TAIL_RE.lastIndex = pastJoins(src, end);
    const tail = NAME_TAIL_RE.exec(src)?.[0];
    if (tail === undefined) break;
    name += tail;
    end = NAME_TAIL_RE.lastIndex;
  }
  return { name, end };
}
