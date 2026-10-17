import { ansiCEnd } from "./balanced.js";
import type { Reading } from "./nested-reading.js";
import { quotedSpanSubstitutions } from "./substitutions.js";
import type { Token } from "./tokens.js";

/**
 * The substitutions in the `$'…'` spans of an arithmetic expansion body, `from` to `to`. bash and zsh read a `$'` there
 * as a plain `'` that quotes as a double quote does, so a `$(` or backtick inside runs although `balancedEnd` takes the
 * span for an ANSI-C string and skips it. A `$'` inside another quote is found too; reading it only adds substitutions.
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
