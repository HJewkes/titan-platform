import { caseFoldedArgs, isCaseUnsure } from "./case-attrs.js";
import type { WordToken } from "./lexer.js";
import { unwrap } from "./unwrap.js";
import type { Unwrapped } from "./unwrap.js";

const FOLDS = [(v: string) => v.toLowerCase(), (v: string) => v.toUpperCase()];

/**
 * The texts `eval` or a shell's `-c` runs from words a case attribute may have changed: as written, all lower and
 * all upper case. Re-tokenizing the text would otherwise drop the mark.
 */
export function caseScripts(words: WordToken[]): string[] {
  return [...new Set(caseFoldedArgs(words).map((ws) => ws.map((w) => w.value).join(" ")))];
}

/**
 * The commands the words run, the as-written reading first. When a case attribute may have changed the word that
 * names the command, it is also read all lower and all upper case, and each reading is unwrapped again so a folded
 * wrapper reaches the command it runs.
 */
export function caseNamed(words: WordToken[], folded: ReadonlySet<number> = new Set()): Unwrapped[] {
  const cmd = unwrap(words);
  if (!cmd) return [];
  const at = words.findIndex((w, i) => !folded.has(i) && isCaseUnsure(w) && w.value === cmd.path && !cmd.args.includes(w));
  const word = words[at];
  if (!word) return [cmd];
  const readings = FOLDS.map((to) => to(word.value)).filter((v, i, all) => v !== word.value && all.indexOf(v) === i);
  const refold = (value: string) => words.map((w, i) => (i === at ? { ...w, value } : w));
  return [cmd, ...readings.flatMap((value) => caseNamed(refold(value), new Set([...folded, at])))];
}
