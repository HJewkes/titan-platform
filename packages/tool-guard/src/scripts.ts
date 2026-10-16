import { INTERPRETERS, SHELLS } from "./mentions.js";
import type { SimpleCommand } from "./shell/commands.js";
import type { WordToken } from "./shell/lexer.js";
import { resolvePath, resolveValue } from "./shell/path.js";
import { shellOperands, shellStdin } from "./shell/shell-options.js";
import { UnknownStdinError } from "./shell/unsure-readings.js";

/** A script a command runs by path: shell scripts are classified in full, others get the mention rule. */
export interface ScriptTarget {
  path: string;
  kind: "shell" | "interpreter";
}

export const SOURCERS: ReadonlySet<string> = new Set(["source", "."]);
const INLINE_FLAG_RE = /^-[A-Za-z]*[ceEpm]$|^--(eval|print)(=|$)/;

export function scriptTarget(cmd: SimpleCommand, home: string): ScriptTarget | null {
  const name = cmd.name;
  if (name === null) return null;
  if (SOURCERS.has(name)) return target(cmd, cmd.args[0], home, "shell");
  if (SHELLS.has(name)) return shellTarget(cmd, home);
  if (INTERPRETERS.has(name)) return target(cmd, firstOperand(cmd.args, INLINE_FLAG_RE, new Set()), home, "interpreter");
  return cmd.path?.endsWith(".sh") ? typedTarget(cmd, cmd.path, home) : null;
}

/** `./x.sh`, `~/bin/x.sh`, `/tmp/x.sh` or a bare `x.sh`, resolved as typed from the command's directory. */
function typedTarget(cmd: SimpleCommand, typed: string, home: string): ScriptTarget | null {
  const path = resolveValue(cmd.dir, typed, home);
  return path === null ? null : { path, kind: "shell" };
}

/**
 * `bash x.sh`, or the file on the descriptor it runs: `bash < x.sh`, `bash /dev/stdin < x.sh`, `bash /dev/fd/3 3< x.sh`.
 * A `-c` string may read stdin too. `bash -c` text and heredocs are already walked by `extractCommands`. A descriptor
 * whose text the line cannot show is refused.
 */
function shellTarget(cmd: SimpleCommand, home: string): ScriptTarget | null {
  const { scriptFile, source, unknowable } = shellStdin(shellOperands(cmd.args, cmd.name), cmd.redirects, false);
  if (unknowable) throw new UnknownStdinError();
  const script = scriptFile === null ? null : target(cmd, scriptFile, home, "shell");
  return script ?? (source.kind === "file" ? target(cmd, source.target, home, "shell") : null);
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
