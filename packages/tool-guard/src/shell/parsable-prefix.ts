import { ParseError, tokenize } from "./lexer.js";

/**
 * The lines of `text` bash would run before its parser fails: it executes a script command by command, so the commands
 * that complete first run and nothing from the failing one on. Found by bisecting on line count. A prefix that parses
 * may follow one that does not (a later quote pairs with the stray one), so the cut can land after the first failure,
 * never before it: it reads at least what runs, and costs about log2(lines) extra parses, not one per line.
 */
export function parsablePrefix(text: string): string {
  if (parses(text)) return text;
  const lines = text.split("\n");
  let [good, bad] = [0, lines.length];
  while (bad - good > 1) {
    const mid = (good + bad) >> 1;
    if (parses(lines.slice(0, mid).join("\n"))) good = mid;
    else bad = mid;
  }
  return lines.slice(0, good).join("\n");
}

function parses(text: string): boolean {
  try {
    tokenize(text);
    return true;
  } catch (error) {
    if (error instanceof ParseError) return false;
    throw error;
  }
}
