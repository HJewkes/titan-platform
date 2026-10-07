import type { WordToken } from "./lexer.js";
import { unwrap } from "./unwrap.js";

/**
 * Bash matches builtins and keywords exactly, so `CD` or `EXPORT` runs a program from PATH in a child, if any, and
 * changes nothing; `IF` is no keyword. `command` stays out: darwin's `/usr/bin/command` runs the command it names.
 */
const EXACT = new Set([
  "cd", "pushd", "popd", "dirs", "export", "declare", "typeset", "local", "readonly", "unset", "read", "readarray",
  "mapfile", "set", "shopt", "alias", "unalias", "source", "eval", "exec", "builtin", "enable", "let", "getopts",
  "shift", "trap", "hash", "umask", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "case",
  "esac", "select", "function", "coproc",
]);

/**
 * The words with the command word lower-cased, as a filesystem that finds a program whatever its case runs it. The
 * words unwrap again after each fold, so a folded wrapper (`ENV`, `SUDO`) reaches its command, whose word folds in
 * turn. Arguments stay as written.
 */
export function foldCommandWords(words: WordToken[]): WordToken[] {
  for (;;) {
    const cmd = unwrap(words);
    const at = cmd ? words.findIndex((w) => !w.dynamic && w.value === cmd.path && !cmd.args.includes(w)) : -1;
    const word = words[at];
    const lower = word?.value.toLowerCase();
    if (!word || lower === undefined || lower === word.value || EXACT.has(lower)) return words;
    words = words.map((w, i) => (i === at ? { ...w, value: lower } : w));
  }
}
