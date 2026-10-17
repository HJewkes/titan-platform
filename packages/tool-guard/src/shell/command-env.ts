import { foldCommandWords } from "./case-literal.js";
import { resolvePath } from "./path.js";
import { ParseError } from "./lexer.js";
import type { Token, WordToken } from "./lexer.js";
import { ValueWalkError } from "./unsure-readings.js";
import type { Unwrapped } from "./unwrap.js";

export function literalEnv(cmd: Unwrapped): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value, kind] of cmd.assigned) if (value !== null && !kind) env[name] = value;
  return env;
}

export function changeDir(dir: string | null, word: WordToken | undefined, home: string | null): string | null {
  if (!word) return home;
  return word.value === "-" ? null : resolvePath(dir, word, home);
}

export function folded(words: WordToken[], w: { foldCase: boolean }): WordToken[] {
  return w.foldCase ? foldCommandWords(words) : words;
}

/** A substitution the lexer rejects while it is walked leaves the line unchecked, which the hook refuses. */
export function walkSure(walkText: () => void): void {
  try {
    walkText();
  } catch (error) {
    throw error instanceof ParseError ? new ValueWalkError() : error;
  }
}

export function nestedLists(token: Token): Token[][] {
  if (token.type === "redirect") return [...(token.target?.subs ?? []), ...token.subs];
  return token.type === "op" ? [] : token.subs;
}
