/**
 * Whether a text could define an alias: `alias`, `expand_aliases` and the rest spell it out. Quotes, backslashes,
 * expansion syntax and spaces are dropped first, so `al""ias`, `\alias` and `al${x:-}ias` count. An alias can rename
 * `[[`, which makes `||` after it a list operator, so the text keeps the split reading. It over-matches by design.
 */
export function mentionsAlias(text: string): boolean {
  return text.replace(/[^A-Za-z_]/g, "").toLowerCase().includes("alias");
}
