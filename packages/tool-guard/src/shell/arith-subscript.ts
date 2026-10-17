import type { LexState } from "./tokens.js";

const DECLARERS = new Set(["declare", "typeset", "local", "export", "readonly"]);

/**
 * Whether the `[ … ]` span bash may read as one word is an array subscript there: an element of `NAME=( … )`, or the
 * subscript of a name a declaring builtin takes. Both are arithmetic for an indexed array, so a quote in one runs a `$(`.
 */
export function inArraySubscript(s: LexState): boolean {
  if (s.compoundDepth !== -1) return true;
  for (let k = s.tokens.length - 1; k >= 0; k--) {
    const t = s.tokens[k];
    if (t?.type === "op") return false;
    if (t?.type === "word" && !t.quoted && DECLARERS.has(t.value)) return true;
  }
  return false;
}
