import { dollarOpener } from "./balanced.js";
import { joinedDollar } from "./joins.js";

/** A backquote or `$( )`/`${ }` opener `skipQuoted` left in place, since it could not find where the span ends. */
export function opensUnsureSpan(src: string, j: number): boolean {
  if (src[j] === "`") return true;
  if (src[j] !== "$") return false;
  const opener = dollarOpener(src, joinedDollar(src, j));
  return opener === "paren" || opener === "braced";
}

/** Characters that can move where bash ends a `${ }` or backquote span, or hide its brackets from the scan. */
const SPAN_MOVERS = "'\"\\`(){\n";

/**
 * What a `$( )` body may hold besides identifier characters. Each is a word character, a pipe or a paren to bash,
 * so its `)` falls where paren counting puts it; a quote, an escape, a brace, a comment, a separator or a redirect
 * may move it, so none is here.
 */
const PAREN_BODY = " \t=+-*/%!~^|?:,.@[]()$";

const IDENTIFIER_CHAR = /[A-Za-z0-9_]/;

/** What follows `${` in a funsub, which holds commands whose `}` need not close it. */
const FUNSUB_START = /[\s|]/;

/**
 * Index of the last character of the unsure `${ }`, `$( )` or backquote span at `j` when it holds only text whose
 * end bash finds as this does, with its own brackets balanced, so skipping it whole pairs the brackets around it as
 * bash's skip does; -1 otherwise. `${` closes at the first `}` that no nested `${` opened, and a backquote at the
 * next one. A `$( )` closes where its parens balance when its body keeps to `PAREN_BODY`, holds no `case` word,
 * whose pattern `)` would not close it, and keeps each paren outside its brackets. A funsub (`${ `, `${⏎`, `${|`)
 * is never self-contained. Each opener is read once per source: nested openers are settled by the pass that meets them.
 */
export function selfContainedEnd(src: string, j: number, known: Map<number, number>): number {
  const cached = known.get(j);
  if (cached !== undefined) return cached;
  if (src[j] !== "`") return framedEnd(src, j, known);
  const end = backquoteEnd(src, j);
  known.set(j, end);
  return end;
}

function backquoteEnd(src: string, j: number): number {
  let brackets = 0;
  for (let k = j + 1; k < src.length; k++) {
    const c = src.charAt(k);
    if (c === "`") return brackets === 0 ? k : -1;
    if (SPAN_MOVERS.includes(c) || c === "$") return -1;
    if (c === "[") brackets++;
    if (c === "]" && --brackets < 0) return -1;
  }
  return -1;
}

interface Frame {
  at: number;
  paren: boolean;
  brackets: number;
  parens: number;
}

interface FrameScan {
  src: string;
  frames: Frame[];
  known: Map<number, number>;
}

/**
 * One pass over the `${` or `$(` at `j` and every one nested in it, with a stack rather than recursion. A span is
 * self-contained only if every span nested in it is, so a failure settles every open frame as -1. `$$` is read as
 * one unit, as bash reads it, so the `{` after it is a bare `{`, which moves the end.
 */
function framedEnd(src: string, j: number, known: Map<number, number>): number {
  const scan: FrameScan = { src, frames: [], known };
  let k = open(scan, j);
  while (k !== -1 && scan.frames.length > 0 && ++k < src.length) k = step(scan, k);
  if (k !== -1 && scan.frames.length === 0) return k;
  for (const f of scan.frames) known.set(f.at, -1);
  return -1;
}

/** Pushes the frame the `$` at `at` opens; the index of its `{` or `(`, or -1 when it cannot be self-contained. */
function open(scan: FrameScan, at: number): number {
  const { src } = scan;
  const brace = joinedDollar(src, at) + 1;
  const paren = src[brace] === "(";
  scan.frames.push({ at, paren, brackets: 0, parens: 1 });
  if (paren) return brace;
  return src[brace] === "{" && !FUNSUB_START.test(src[brace + 1] ?? "") ? brace : -1;
}

/** Reads the character at `k` into the innermost frame; the index of the last character read, or -1 on failure. */
function step(scan: FrameScan, k: number): number {
  const { src, frames } = scan;
  const c = src.charAt(k);
  const next = src[k + 1];
  if (c === "$" && (next === "{" || next === "(")) return open(scan, k);
  if (c === "$" && next === "$") return k + 1;
  const top = frames.at(-1);
  if (!top || !(top.paren ? inParenBody(src, k, c) : !SPAN_MOVERS.includes(c))) return -1;
  if (c === "[") top.brackets++;
  if (c === "]" && --top.brackets < 0) return -1;
  const closes = top.paren ? c === ")" && --top.parens === 0 : c === "}";
  if (top.paren && "()".includes(c) && top.brackets > 0) return -1;
  if (c === "(" && top.paren) top.parens++;
  return closes ? settle(scan, k) : k;
}

/** Whether `c` at `k` keeps a `$( )` body's end where paren counting puts it. */
function inParenBody(src: string, k: number, c: string): boolean {
  if (!IDENTIFIER_CHAR.test(c)) return PAREN_BODY.includes(c);
  return IDENTIFIER_CHAR.test(src[k - 1] ?? "") || !src.startsWith("case", k) || IDENTIFIER_CHAR.test(src[k + 4] ?? "");
}

/** Closes the innermost frame at `k`: `k`, or -1 when its brackets are unbalanced. */
function settle(scan: FrameScan, k: number): number {
  const top = scan.frames.at(-1);
  if (!top || top.brackets !== 0) return -1;
  scan.frames.pop();
  scan.known.set(top.at, k);
  return k;
}
