import { ansiCEnd } from "./balanced.js";
import { lineReading, nestedReaders, type Reading } from "./nested-reading.js";
import { quotedSpanSubstitutions } from "./substitutions.js";
import type { LexState, Token, WordToken } from "./tokens.js";
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

/**
 * The substitutions in the `$'…'` spans of a `$(( ))` body, `from` to `to`, which `balancedEnd` skips as ANSI-C strings.
 * A `$'` inside another quote is found too; reading it only adds substitutions.
 */
export function ansiQuotedSubstitutions(at: Reading, from: number, to: number): Token[][] {
  const found: Token[][] = [];
  for (let j = from; j < to; j++) {
    if (at.src[j] === "\\") j++;
    else if (at.src[j] === "$" && at.src[j + 1] === "'") {
      const end = Math.min(ansiCEnd(at.src, j + 1), to);
      found.push(...quotedSpanSubstitutions(at, j + 2, end));
      j = end;
    }
  }
  return found;
}
