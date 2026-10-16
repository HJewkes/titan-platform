import { nextAfter } from "./joins.js";

/**
 * zsh runs code held in a parameter's value two ways: the `~` flag (`${~x}`, `$~x`) globs the value, so `*(e:CODE:)`
 * runs CODE as a qualifier, and the `e` flag (`${(e)x}`) runs the value's substitutions. The guard cannot know the
 * value, so the lexer refuses any `$` that opens either.
 */

/** Characters zsh reads between `${` and the name; `~` among them turns globbing of the value on. */
const BRACED_RUN = new Set(["^", "=", "~", "#", "+"]);
const UNBRACED_RUN = new Set(["^", "=", "~"]);
/** Flags whose argument follows, closed by the delimiter's pair or by the delimiter itself. */
const ARGUMENT_FLAGS = new Set(["g", "I", "j", "l", "r", "s", "Z", "_"]);
/** `l` and `r` take a width, then up to two fill strings, all with the same delimiter. */
const PADDING_FLAGS = new Set(["l", "r"]);
const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };
/** A group or argument reaches the end of the source, or holds `e`: either way the `$` is refused. */
const RUNS = -1;

/** Whether the `$` at `dollar` opens a zsh expansion that globs its value (`~`) or runs its substitutions (`e`). */
export function zshRunsValue(src: string, dollar: number): boolean {
  const at = nextAfter(src, dollar);
  if (src[at] !== "{") return runHoldsTilde(src, at, UNBRACED_RUN);
  for (let i = nextAfter(src, at); i < src.length; ) {
    const c = src.charAt(i);
    if (c === "~") return true;
    if (BRACED_RUN.has(c)) i = nextAfter(src, i);
    else if (c === "(") i = flagGroupEnd(src, i);
    else return false;
    if (i === RUNS) return true;
  }
  return true;
}

function runHoldsTilde(src: string, at: number, run: Set<string>): boolean {
  for (let i = at; i < src.length && run.has(src.charAt(i)); i = nextAfter(src, i)) if (src[i] === "~") return true;
  return false;
}

/** Index past the `)` that closes the flag group opened at `open`, or RUNS. */
function flagGroupEnd(src: string, open: number): number {
  for (let i = nextAfter(src, open); i < src.length; ) {
    const flag = src.charAt(i);
    if (flag === ")") return nextAfter(src, i);
    if (flag === "e") return RUNS;
    i = nextAfter(src, i);
    if (ARGUMENT_FLAGS.has(flag)) i = argumentsEnd(src, i, PADDING_FLAGS.has(flag) ? 3 : 1);
    if (i === RUNS) return RUNS;
  }
  return RUNS;
}

/** Index past up to `max` delimited arguments starting at `at`; the first is required, later ones reuse its delimiter. */
function argumentsEnd(src: string, at: number, max: number): number {
  if (at >= src.length) return RUNS;
  const open = src.charAt(at);
  const close = CLOSERS[open] ?? open;
  let i = at;
  for (let n = 0; n < max && src[i] === open; n++) {
    let j = nextAfter(src, i);
    while (j < src.length && src[j] !== close) j = nextAfter(src, j);
    if (j >= src.length) return RUNS;
    i = nextAfter(src, j);
  }
  return i;
}
