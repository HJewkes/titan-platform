import { NAMED_FD_RE } from "./lexer.js";
import type { RedirectToken, WordToken } from "./lexer.js";
import { DECLARERS } from "./name-slots.js";

/** A text the shell evaluates as math, and whether it holds a run-time expansion. */
export interface MathPlace {
  text: string;
  dynamic: boolean;
}

export const ARITHMETIC_OPENER_RE = /\$\(\(|\$\[/g;
/** Where a subscript opens in an expansion: after `${name` or `$name`. */
const EXPANSION_SUBSCRIPT_RE = /\$\{[^}\s]*?[A-Za-z0-9_@*]\[|\$[A-Za-z_]\w*\[/g;
/** A word that begins as a name with a subscript, which the shell takes as an element assignment: `a[$i]=1`. */
const ASSIGNED_SUBSCRIPT_RE = /^[A-Za-z_]\w*\[/;
/** A literal element write, whose subscript is math even when no expansion is in it: `a[commands[y]=0]=1`. */
const ELEMENT_WRITE_RE = /\]\+?=/;
/** `${x:offset}` and `${x:offset:length}`: a colon after the name that opens no `:-`, `:=`, `:+`, `:?` or zsh `:#` operator. */
const SUBSTRING_OPENER_RE = /\$\{[!#]?(?:[A-Za-z_]\w*(?:\[[^\]]*\])?|[@*]|\d+):(?![-=+?#])/g;

/**
 * Every place a shell evaluates math inside words and redirects, apart from a command whose operands are wholly math.
 * One list serves `storesRebindingByMath` and `arithmeticHookedIn`, so a new place is added once: the body of a `$(( ))`
 * or `$[ ]`, a subscript of an element read or named, a substring offset or length, and a descriptor variable's
 * subscript, in a run-time word, a redirect target, or an unquoted heredoc body.
 */
export function mathPlaces(words: WordToken[], redirects: RedirectToken[]): MathPlace[] {
  const declarer = words.findIndex((w) => !w.dynamic && !w.quoted && DECLARERS.has(w.value));
  // A declarer reads its arguments as assignments however they are quoted: `declare 'a[i]=1'`.
  const from = (w: WordToken, i: number) => (declarer >= 0 && i > declarer ? Infinity : quotedAt(w));
  const sources = [
    ...words.map((w, i) => (w.dynamic ? spansOf(w.value, from(w, i), false) : literalElementWrite(w, from(w, i)))),
    ...redirects.flatMap((r) => (r.target?.dynamic ? [spansOf(r.target.value, quotedAt(r.target), false)] : [])),
    ...redirects.flatMap((r) => (r.body && r.target?.quoted !== true ? [spansOf(r.body, 0, false)] : [])),
  ];
  const subscripts = redirects.flatMap((r) => NAMED_FD_RE.exec(r.named ?? r.fd ?? "")?.[2]?.slice(1, -1) ?? []);
  return [...sources.flat().map((text) => ({ text, dynamic: true })), ...subscripts.map((text) => ({ text, dynamic: /[$`]/.test(text) }))];
}

/** Where quoting begins in a word; one another builder made quoted is taken as quoted from its start. */
const quotedAt = (w: WordToken): number => w.quotedAt ?? (w.quoted ? 0 : Infinity);

/** The subscript of a word with no expansion in it that writes an element, which is math all the same. */
const literalElementWrite = (w: WordToken, quotedFrom: number): string[] => (ELEMENT_WRITE_RE.test(w.value) ? spansOf(w.value, quotedFrom, true) : []);

/**
 * The outermost spans: an opener inside an earlier span is read with it, which keeps the scan linear. The shell takes a
 * word as an element assignment while its name and `[` are unquoted, so quoting from `quotedFrom` on keeps the subscript.
 */
function spansOf(text: string, quotedFrom: number, elementOnly: boolean): string[] {
  const head = ASSIGNED_SUBSCRIPT_RE.exec(text);
  const assigned = head !== null && head[0].length <= quotedFrom ? head : null;
  const expansions = elementOnly ? [] : [...text.matchAll(ARITHMETIC_OPENER_RE), ...text.matchAll(EXPANSION_SUBSCRIPT_RE), ...text.matchAll(SUBSTRING_OPENER_RE)];
  const openers = [...expansions, ...(assigned ? [assigned] : [])];
  const spans: string[] = [];
  let past = 0;
  for (const opener of openers.sort((x, y) => x.index - y.index)) {
    const from = opener.index + opener[0].length;
    if (from <= past) continue;
    const [open, close, depth] = closers(opener[0]);
    past = closeAt(text, from, open, close, depth);
    spans.push(text.slice(from, past));
  }
  return spans;
}

function closers(opener: string): [string, string, number] {
  if (opener === "$((") return ["(", ")", 2];
  return opener.endsWith(":") ? ["{", "}", 1] : ["[", "]", 1];
}

/** Index where nesting returns to zero, or the text's end when it never does (an unclosed span is read to the end). */
function closeAt(text: string, from: number, open: string, close: string, depth: number): number {
  let left = depth;
  for (let i = from; i < text.length; i++) {
    if (text[i] === open) left++;
    else if (text[i] === close && --left === 0) return i;
  }
  return text.length;
}
