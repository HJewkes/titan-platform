import { foldCommandWords } from "./case-literal.js";
import { resolvePath } from "./path.js";
import type { WordToken } from "./lexer.js";
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
