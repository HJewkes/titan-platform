import type { WordToken } from "./tokens.js";

/** Shells whose `-c` string, heredoc, here-string or piped input the walk reads as script. */
export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SHELL_VALUE_OPTS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);

/** Whether a shell's options include `-c`, and its first operand: the `-c` string, or else a script file. */
export function shellOperands(args: WordToken[]): { hasC: boolean; positional: WordToken | null } {
  let hasC = false;
  for (let i = 0, word = args[0]; word; word = args[++i]) {
    const v = word.value;
    if (v === "-") break;
    if (v === "--") return { hasC, positional: args[i + 1] ?? null };
    if (SHELL_VALUE_OPTS.has(v)) i++;
    else if (v.startsWith("--")) continue;
    else if (/^[-+][A-Za-z]+$/.test(v)) hasC ||= v.startsWith("-") && v.includes("c");
    else return { hasC, positional: word };
  }
  return { hasC, positional: null };
}
