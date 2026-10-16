import type { WordToken } from "./lexer.js";

/** A brace expansion, `{a,b}` or `{1..3}`, which makes one typed word several. */
export const BRACE_RE = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;
/**
 * A zsh generation operator, which may turn the word into file names or a directory: a glob character, extendedglob's
 * `^`, `#` and `x~y`, a tilde (`~+`, `~1`, `~user`), or a leading `=` naming a command's path. A `(` qualifier never
 * reaches here: the lexer refuses it.
 */
const GLOB_RE = /[*?[^#~]|^=/;

/** A glob, a tilde, an `=` path or braces the shell may expand into other words. */
export function mayGenerate(w: WordToken): boolean {
  return mayBraceExpand(w) || (mayBeUnquoted(w) && GLOB_RE.test(w.value));
}

/** Braces the shell may expand, one alternative of which may spell a name the whole word does not. */
export function mayBraceExpand(w: WordToken): boolean {
  return mayBeUnquoted(w) && BRACE_RE.test(w.value);
}

/** The word is not wholly quoted, so the lexer cannot say which of its characters were. */
export function mayBeUnquoted(w: WordToken): boolean {
  return !w.quoted || w.spliced;
}
