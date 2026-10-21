import type { WordToken } from "./lexer.js";

/** The builtins that run a file in the current shell. */
export const SOURCERS: ReadonlySet<string> = new Set(["source", "."]);

/**
 * The file `source` or `.` reads: its first word, or the one after a `--` that ends its options, as bash and zsh read
 * it. Quote removal comes first, so `'--'` and `\-\-` end the options too. Every reader of a sourcer's script word
 * takes it from here, so none of them can read `--` as the file while another reads what follows it.
 */
export function sourcedOperand(args: readonly WordToken[]): WordToken | undefined {
  const [first, second] = args;
  return first?.value === "--" ? second : first;
}
