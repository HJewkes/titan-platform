import type { WordToken } from "./lexer.js";
import { arrayElements } from "./declarations.js";

const SUBSCRIPT_WRITE_RE = /^[A-Za-z_]\w*\[.*\]\+?=/s;
/** An element read, a substring offset or length, an indirect expansion, or a `$[ ]`. */
const EXPANSION_RE = /\$\{[!#]?[A-Za-z_]\w*\[|\$\{[A-Za-z_]\w*(?:\[[^\]]*\])?:(?![-=+?])|\$\{!|\$\[/;
const DECLARER_RE = /^(?:declare|typeset|local)$/;
/** `-i` evaluates what a name is set to; `-n` makes a name whose value names another, subscript and all. */
const EVALUATING_OPTION_RE = /^-[a-zA-Z]*[in]/;

/**
 * Whether a command's words make bash evaluate arithmetic apart from `(( ))`, `let` and `[[`: a `$[ ]`, an array
 * subscript written, read or keyed in a compound array, a substring offset, an indirect expansion, or the names a
 * `declare -i` or `-n` lists.
 */
export function wordsEvaluateArithmetic(words: WordToken[]): boolean {
  const values = words.map((w) => w.value);
  if (values.some((v) => SUBSCRIPT_WRITE_RE.test(v) || EXPANSION_RE.test(v))) return true;
  if (words.some((w) => (arrayElements.get(w) ?? []).some((e) => e.value.startsWith("[")))) return true;
  const at = values.findIndex((v) => DECLARER_RE.test(v));
  return at >= 0 && values.slice(at + 1).some((v) => EVALUATING_OPTION_RE.test(v));
}
