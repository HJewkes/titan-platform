import { decodeAnsiC } from "./ansi-c.js";
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
  ensureWord(s).value += c;
  s.i++;
}

/** What may follow the `~` of a tilde prefix that names `HOME` itself: an unquoted `/`, a `:`, or the end of the word. */
const TILDE_END_RE = /[/:\s;&|()<>]/;

/**
 * Notes an unquoted `~` the shell expands to `HOME`: one after the assignment's `=` or an unescaped `:`. The `/` after
 * it must be unquoted too, as `~"/b"` stays literal; a `~user` prefix names another directory, so it is not noted.
 */
export function noteTilde(s: LexState): void {
  const [before, prev, next] = [s.src[s.i - 2], s.src[s.i - 1], s.src[s.i + 1]];
  if ((prev !== "=" && prev !== ":") || before === "\\" || (next !== undefined && !TILDE_END_RE.test(next))) return;
  const w = ensureWord(s);
  w.tildes = { text: "", at: [...(w.tildes?.at ?? []), w.value.length] };
}

/** Where `value` holds a tilde prefix the shell expands, or none once anything has rewritten the word since it was read. */
export function tildeStarts(w: WordToken): number[] {
  return w.tildes?.text === w.value ? w.tildes.at : [];
}

/** The noted tildes of `w` in `value`, which replaced each of its `refs` by its literal and so moved every tilde after it. */
export function shiftedTildes(w: WordToken, literals: string[], value: string): WordToken["tildes"] {
  if (tildeStarts(w).length === 0) return undefined;
  const shift = (tilde: number) => w.refs.reduce((sum, ref, i) => (ref.end <= tilde ? sum + (literals[i] ?? "").length - (ref.end - ref.start) : sum), 0);
  return { text: value, at: tildeStarts(w).map((tilde) => tilde + shift(tilde)) };
}

export function endWord(s: LexState): void {
  const w = s.word;
  if (!w) return;
  s.word = null;
  if (w.tildes) w.tildes.text = w.value;
  const pending = s.redirect;
  s.redirect = null;
  if (!pending) {
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
    w.value += next;
    w.quoted = true;
    w.spliced = true;
  }
}

export function readSingle(s: LexState): void {
  const end = s.src.indexOf("'", s.i + 1);
  if (end === -1) throw new ParseError("unterminated '");
  const w = markQuoted(ensureWord(s));
  w.value += s.src.slice(s.i + 1, end);
  s.i = end + 1;
}

export function readAnsiC(s: LexState, w: WordToken): void {
  const end = ansiCEnd(s.src, s.i + 1);
  w.value += decodeAnsiC(s.src.slice(s.i + 2, end));
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
