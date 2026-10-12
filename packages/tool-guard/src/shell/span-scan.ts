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

/** What follows `${` in a funsub, which holds commands whose `}` need not close it. */
const FUNSUB_START = /[\s|]/;

/**
 * Index of the last character of the unsure `${ }` or backquote span at `j` when it holds only text whose end bash
 * finds as this does, with its own brackets balanced, so skipping it whole pairs the brackets around it as bash's
 * skip does; -1 otherwise. `${` closes at the first `}` that no nested `${` opened, and a backquote at the next one.
 * A `$( )` may hold a `case` whose `)` moves its end, so it is never self-contained, nor is a funsub (`${ `, `${⏎`, `${|`).
 * Each opener is read once per source: nested `${` openers are settled by the pass that meets them.
 */
export function selfContainedEnd(src: string, j: number, known: Map<number, number>): number {
  const cached = known.get(j);
  if (cached !== undefined) return cached;
  if (src[j] !== "`") return bracedEnd(src, j, known);
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

interface BracedFrame {
  at: number;
  brackets: number;
}

/**
 * One pass over the `${` at `j` and every `${` nested in it, with a stack rather than recursion. A span is
 * self-contained only if every span nested in it is, so a failure settles every open frame as -1. `$$` is read as
 * one unit, as bash reads it, so the `{` after it is a bare `{`, which moves the end.
 */
function bracedEnd(src: string, j: number, known: Map<number, number>): number {
  const frames: BracedFrame[] = [];
  const failAll = (): number => {
    for (const f of frames) known.set(f.at, -1);
    return -1;
  };
  const open = (at: number, brace: number): boolean => {
    frames.push({ at, brackets: 0 });
    return src[brace] === "{" && !FUNSUB_START.test(src[brace + 1] ?? "");
  };
  const brace = joinedDollar(src, j) + 1;
  if (!open(j, brace)) return failAll();
  for (let k = brace + 1; k < src.length; k++) {
    const c = src.charAt(k);
    const next = src[k + 1];
    if (c === "$" && next === "{" && !open(k, k + 1)) return failAll();
    if (c === "$" && (next === "{" || next === "$")) k++;
    else if (SPAN_MOVERS.includes(c) || closesBadly(frames, c)) return failAll();
    else if (c === "}") {
      const done = settle(frames, k, known);
      if (done !== null) return done === -1 ? failAll() : done;
    }
  }
  return failAll();
}

/** Counts a bracket into the innermost frame; true when a `]` closes more than it opened. */
function closesBadly(frames: BracedFrame[], c: string): boolean {
  const top = frames.at(-1);
  if (!top) return true;
  if (c === "[") top.brackets++;
  return c === "]" && --top.brackets < 0;
}

/** Closes the innermost frame at `k`: -1 when it is unbalanced, `k` when it was the outermost, else null. */
function settle(frames: BracedFrame[], k: number, known: Map<number, number>): number | null {
  const top = frames.at(-1);
  if (!top || top.brackets !== 0) return -1;
  frames.pop();
  known.set(top.at, k);
  return frames.length === 0 ? k : null;
}
