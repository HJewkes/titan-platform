import type { WordToken } from "./lexer.js";

/** Characters zsh rewrites in an unquoted word: braces, globs, extendedglob `^ # ~`, numeric ranges and groups. */
const REWRITTEN_RE = /[{*?[^#~<>()|]/;
/** A `$NAME`, `${NAME}` or positional parameter; `@` and `*` expand to several words. */
const PLAIN_REF_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*|\d+)$/;

export type CommandWordShape = { kind: "literal"; name: string } | { kind: "one" } | { kind: "many" };

/** The part of an unquoted word that zsh may rewrite: `~` and `~/` lead a path, every other `~` is a name or a pattern. */
function rewrittenPart(text: string): string {
  if (text === "~") return "";
  return text.startsWith("~/") ? text.slice(2) : text;
}

/** The value of text typed with no quotes, or null when zsh rewrites it before any program sees it. */
export function literalText(text: string): string | null {
  if (text === "[" || text === "[[") return text;
  if (text.startsWith("=") || text.includes("$")) return null;
  return REWRITTEN_RE.test(rewrittenPart(text)) ? null : text;
}

/**
 * The value of a word only when no evaluator rewrites or runs it first: it is not dynamic, a lexer-literal `$=x` is
 * not left in it, and unquoted or spliced text holds no `=` lead, `~name`, brace, glob or extendedglob character.
 * A spliced word is judged whole because the lexer does not say which of its parts were quoted.
 */
export function literalValue(w: WordToken): string | null {
  if (w.dynamic || w.unquotedExpansion) return null;
  return w.quoted && !w.spliced ? w.value : literalText(w.value);
}

function isOneWord(w: WordToken): boolean {
  if (!w.dynamic || !w.quoted || w.spliced || w.computed || w.unquotedExpansion || w.subs.length > 0) return false;
  if (w.refs.length === 0 || !w.refs.every((r) => PLAIN_REF_RE.test(r.name))) return false;
  let rest = "";
  let at = 0;
  for (const r of [...w.refs].sort((a, b) => a.start - b.start)) {
    rest += w.value.slice(at, r.start);
    at = r.end;
  }
  return !`${rest}${w.value.slice(at)}`.includes("$");
}

/**
 * How many words a command word becomes. Owner option Q1-B: a double-quoted `$NAME` is one word, so it stays an
 * unknown name, while an unquoted or splitting form may be several words. Switching to A or C changes this function only.
 */
export function commandWordShape(w: WordToken): CommandWordShape {
  const name = literalValue(w);
  if (name !== null) return { kind: "literal", name };
  if (!w.dynamic && !w.quoted && !w.unquotedExpansion && w.value.length > 1 && w.value.startsWith("=")) {
    const found = literalText(w.value.slice(1));
    if (found !== null) return { kind: "literal", name: found };
  }
  return isOneWord(w) ? { kind: "one" } : { kind: "many" };
}
