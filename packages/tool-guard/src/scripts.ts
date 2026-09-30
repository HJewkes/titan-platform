import { INTERPRETERS, SHELLS } from "./mentions.js";
import type { SimpleCommand } from "./shell/commands.js";
import type { WordToken } from "./shell/lexer.js";
import { resolveFrom, resolvePath } from "./shell/path.js";

/** A script a command runs by path: shell scripts are classified in full, others get the mention rule. */
export interface ScriptTarget {
  path: string;
  kind: "shell" | "interpreter";
}

const SOURCERS = new Set(["source", "."]);
const SHELL_VALUE_OPTS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
const INLINE_FLAG_RE = /^-[A-Za-z]*[ceEpm]$|^--(eval|print)(=|$)/;

export function scriptTarget(cmd: SimpleCommand, home: string): ScriptTarget | null {
  const name = cmd.name;
  if (name === null) return null;
  if (SOURCERS.has(name)) return target(cmd, cmd.args[0], home, "shell");
  if (SHELLS.has(name)) return shellTarget(cmd, home);
  if (INTERPRETERS.has(name)) return target(cmd, firstOperand(cmd.args, INLINE_FLAG_RE, new Set()), home, "interpreter");
  if (name.endsWith(".sh") && cmd.dir !== null) return { path: resolveFrom(cmd.dir, name), kind: "shell" };
  return null;
}

/** `bash x.sh`, or `bash < x.sh`. `bash -c` text and heredocs are already walked by `extractCommands`. */
function shellTarget(cmd: SimpleCommand, home: string): ScriptTarget | null {
  const operand = firstOperand(cmd.args, /^-[A-Za-z]*c[A-Za-z]*$/, SHELL_VALUE_OPTS);
  if (operand !== null) return target(cmd, operand, home, "shell");
  const stdin = cmd.redirects.find((r) => r.op === "<");
  return stdin ? target(cmd, stdin.target ?? undefined, home, "shell") : null;
}

/** The first non-option word, null when an option in `inline` means the program text is inline. */
function firstOperand(args: WordToken[], inline: RegExp, valueOpts: Set<string>): WordToken | null {
  for (let i = 0; i < args.length; i++) {
    const v = (args[i] as WordToken).value;
    if (inline.test(v)) return null;
    if (valueOpts.has(v)) i++;
    else if (v === "--") return args[i + 1] ?? null;
    else if (!v.startsWith("-") && !v.startsWith("+")) return args[i] as WordToken;
  }
  return null;
}

function target(cmd: SimpleCommand, word: WordToken | null | undefined, home: string, kind: ScriptTarget["kind"]): ScriptTarget | null {
  const path = resolvePath(cmd.dir, word, home);
  return path === null ? null : { path, kind };
}
