import type { WordToken } from "./lexer.js";

/** The builtins that run a file in the current shell. */
export const SOURCERS: ReadonlySet<string> = new Set(["source", "."]);

/** A file a sourcer may read; `optional` when every reading that names it may find none there, so an absent one runs nothing. */
export interface SourcedFile {
  word: WordToken;
  optional?: true;
}

/**
 * The files `source` or `.` may read. zsh reads its first word, or the one after a `--` that ends its options. bash 5.3
 * also reads `-p PATH` and looks a file named without a `/` up in PATH, and takes a word zsh reads as the file (`-p`,
 * `-x`) as an option, so zsh's dash word is optional. Quote removal comes first, so `'--'` and `\-\-` end the options
 * too. A first word only known at run time may expand to `--`, `-p` or nothing, so every later word may be the file.
 * Every reader of a sourcer's script word takes it from here, so none of them can read one word while another reads
 * another.
 */
export function sourcedFiles(args: readonly WordToken[]): SourcedFile[] {
  const [first, second] = args;
  if (first === undefined) return [];
  if (first.dynamic || first.computed) return [{ word: first }, ...args.slice(1).map((word) => ({ word, optional: true as const }))];
  const zsh = first.value === "--" ? second : first;
  const bash = bashFiles(args);
  if (zsh === undefined || bash.some((file) => file.word === zsh)) return bash;
  return [{ word: zsh, ...(zsh.value.startsWith("-") && zsh.value !== "-" ? { optional: true as const } : {}) }, ...bash];
}

/** bash 5.3's `source [-p PATH] [--] FILE`: an option other than `-p` makes it refuse the line and read nothing. */
function bashFiles(args: readonly WordToken[]): SourcedFile[] {
  let path: WordToken | null = null;
  let i = 0;
  for (; i < args.length; i++) {
    const v = (args[i] as WordToken).value;
    if (v === "--") {
      i++;
      break;
    }
    if (!v.startsWith("-") || v === "-") break;
    if (!v.startsWith("-p")) return [];
    path = v === "-p" ? (args[++i] ?? null) : { ...(args[i] as WordToken), value: v.slice(2) };
    if (path === null) return [];
  }
  const file = args[i];
  if (file === undefined) return [];
  return path === null ? [{ word: file }] : searched(file, path);
}

/** A file named without a `/` is looked for in each of PATH's directories, an empty one being the current one; a miss is no file. */
function searched(file: WordToken, path: WordToken): SourcedFile[] {
  if (file.value.includes("/") || path.dynamic || path.computed) return [{ word: file }];
  return path.value.split(":").map((dir) => ({ word: { ...file, value: `${dir === "" ? "." : dir}/${file.value}` }, optional: true as const }));
}
