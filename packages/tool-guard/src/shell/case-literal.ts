import type { WordToken } from "./lexer.js";
import { unwrap } from "./unwrap.js";
import type { Unwrapped } from "./unwrap.js";

/**
 * The commands the words also run when the filesystem finds a program whatever its case: the command word lower-cased,
 * unwrapped again so a folded wrapper (`ENV`, `SUDO`) reaches its command, whose word may fold in turn. Arguments stay
 * as written. The caller walks these beside the as-written reading and lets them only add commands: bash matches a
 * builtin such as `cd` exactly, so a folded `CD` must not move the walk's directory.
 */
export function literalFolds(words: WordToken[], cmd: Unwrapped | null): Unwrapped[] {
  const at = cmd ? words.findIndex((w) => !w.dynamic && w.value === cmd.path && !cmd.args.includes(w)) : -1;
  const word = words[at];
  if (!word || word.value.toLowerCase() === word.value) return [];
  const folded = words.map((w, i) => (i === at ? { ...w, value: w.value.toLowerCase() } : w));
  const run = unwrap(folded);
  return run ? [run, ...literalFolds(folded, run)] : [];
}
