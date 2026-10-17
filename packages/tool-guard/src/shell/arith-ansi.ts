import { ansiCEnd } from "./balanced.js";
import { lineReading, nestedReaders } from "./nested-reading.js";
import type { LexState, WordToken } from "./tokens.js";
import { markComputed, readAnsiC } from "./word-build.js";

/**
 * A `$'…'` in an arithmetic body ends where an ANSI-C string does, which is how bash and zsh find the closing `))`, but
 * expands as a `'` that quotes like a double quote: a `$(` or backtick inside runs. The span is read both ways, its
 * substitutions kept beside the decoded string.
 */
export function readAnsiInArith(s: LexState, w: WordToken): void {
  const end = ansiCEnd(s.src, s.i + 1);
  nestedReaders(lineReading(s), markComputed(w).subs).quotedSpan(s.i + 2, end);
  readAnsiC(s, w);
}
