import { INTERPRETERS, SHELLS } from "./mentions.js";
import type { SimpleCommand } from "./shell/commands.js";
import type { WordToken } from "./shell/lexer.js";
import { resolvePath, resolveValue } from "./shell/path.js";
import { hasArithmeticCommand } from "./shell/inline-script.js";
import { shellOperands, shellStdin } from "./shell/shell-options.js";
import { UnknownStdinError } from "./shell/unsure-readings.js";

/** A script a command runs by path: shell scripts are classified in full, others get the mention rule. */
export interface ScriptTarget {
  path: string;
  kind: "shell" | "interpreter";
  /**
   * What says whether the shell running it has `(( ))`: the runner named on the line (`bash x.sh` true, `sh x.sh`
   * false), the shell that sources it, or the script's own `#!` line when it is run by path.
   */
  shell: boolean | "inherit" | "shebang";
}

export const SOURCERS: ReadonlySet<string> = new Set(["source", "."]);
const INLINE_FLAG_RE = /^-[A-Za-z]*[ceEpm]$|^--(eval|print)(=|$)/;

/** The scripts a command runs by path; a shell runs every file on the descriptor it reads, as zsh's MULTIOS joins them. */
export function scriptTargets(cmd: SimpleCommand, home: string): ScriptTarget[] {
  const name = cmd.name;
  if (name !== null && SHELLS.has(name)) return shellTargets(cmd, home);
  const one = name === null ? null : scriptTarget(cmd, name, home);
  return one === null ? [] : [one];
}

function scriptTarget(cmd: SimpleCommand, name: string, home: string): ScriptTarget | null {
  if (SOURCERS.has(name)) return target(cmd, cmd.args[0], home, "shell", "inherit");
  if (INTERPRETERS.has(name)) return target(cmd, firstOperand(cmd.args, INLINE_FLAG_RE, new Set()), home, "interpreter", false);
  return cmd.path?.endsWith(".sh") ? typedTarget(cmd, cmd.path, home) : null;
}

/** `./x.sh`, `~/bin/x.sh`, `/tmp/x.sh` or a bare `x.sh`, resolved as typed from the command's directory. */
function typedTarget(cmd: SimpleCommand, typed: string, home: string): ScriptTarget | null {
  const path = resolveValue(cmd.dir, typed, home);
  return path === null ? null : { path, kind: "shell", shell: "shebang" };
}

/**
 * `bash x.sh`, or each file on the descriptor it runs: `bash < x.sh`, `bash /dev/stdin < x.sh`, `bash /dev/fd/3 3< x.sh`.
 * A `-c` string may read stdin too. `bash -c` text and heredocs are already walked by `extractCommands`. A descriptor
 * whose text the line cannot show is refused.
 */
function shellTargets(cmd: SimpleCommand, home: string): ScriptTarget[] {
  const { scriptFile, sources, unknowable } = shellStdin(shellOperands(cmd.args, cmd.name), cmd.redirects, false, cmd.inherited);
  if (unknowable) throw new UnknownStdinError();
  const shell = hasArithmeticCommand(cmd);
  const script = scriptFile === null ? null : target(cmd, scriptFile, home, "shell", shell);
  if (script !== null) return [script];
  return sources.flatMap((s) => (s.kind === "file" ? [target(cmd, s.target, home, "shell", shell)].filter((t): t is ScriptTarget => t !== null) : []));
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

function target(cmd: SimpleCommand, word: WordToken | null | undefined, home: string, kind: ScriptTarget["kind"], shell: ScriptTarget["shell"]): ScriptTarget | null {
  const path = resolvePath(cmd.dir, word, home);
  return path === null ? null : { path, kind, shell };
}

/**
 * Whether a script run by path, or sourced, gets a shell with `(( ))`. Only a `#!` naming bash or zsh, directly or
 * through `env`, and without `--posix` says so; no `#!` leaves the choice to whatever runs it, which may be dash.
 */
export function scriptArithmetic(cmd: SimpleCommand, target: ScriptTarget, text: string): boolean {
  if (target.shell === "inherit") return cmd.arithmetic === true;
  return target.shell === "shebang" ? shebangArithmetic(text) : target.shell;
}

/** Fail closed: an exact allowlist of `#!` lines, because any other env option may take bash as its argument. */
const ARITHMETIC_SHEBANG = /^(?:\/bin\/|\/usr\/bin\/)(?:bash|zsh)(?:[ \t].*)?$|^\/(?:usr\/)?bin\/env(?:[ \t]+-i)?(?:[ \t]+-S)?[ \t]+(?:bash|zsh)(?:[ \t].*)?$/;

function shebangArithmetic(text: string): boolean {
  const line = /^#!([^\n]*)/.exec(text)?.[1];
  return line !== undefined && ARITHMETIC_SHEBANG.test(line.trim());
}
