import { closeSync, constants, openSync, readSync, statSync } from "node:fs";
import { INTERPRETERS, SHELLS } from "./mentions.js";
import type { SimpleCommand } from "./shell/commands.js";
import type { WordToken } from "./shell/lexer.js";
import { mayBeWritten } from "./line-writes.js";
import { isNativeProgram, parseShebang } from "./shebang.js";
import type { ClassifyContext } from "./types.js";
import { resolvePath, resolveValue } from "./shell/path.js";
import { hasProcsubOperand, procsubTargets, withoutProcsubOperands } from "./shell/procsub-operand.js";
import { shellOperands, shellStdin } from "./shell/shell-options.js";
import { UnknownStdinError, UnreadableScriptError } from "./shell/unsure-readings.js";

/** A script a command runs by path: shell scripts are classified in full, others get the mention rule. */
export interface ScriptTarget {
  path: string;
  kind: "shell" | "interpreter";
  /** A `-c` shell's stdin file, which only a command in the string may run (`bash -c 'cat | bash' < x.sh`), so it is read as far as it reads. */
  relayed?: true;
  /** Run as `./x.sh`, so the kernel reads its `#!` line and the interpreter's options and operands decide what runs. */
  byPath?: true;
}

/** A script run by path whose `#!` line carries options or operands the guard does not follow; the hook denies it unchecked. */
export class OpaqueShebangError extends UnreadableScriptError {
  constructor() {
    super(null);
    this.message = "a script run by path whose #! line the guard cannot follow";
    this.name = "OpaqueShebangError";
  }
}

/** Whether a script's first line is one the guard cannot follow, whoever runs it. */
export function hasOpaqueShebang(text: string): boolean {
  return parseShebang(text).kind === "opaque";
}

/** Refuses a by-path script found to have an opaque first line, as the interpreter it names may run something other than the body. */
export function refuseOpaqueShebang(target: ScriptTarget, opaque: ReadonlySet<string>): void {
  if (target.byPath && opaque.has(target.path)) throw new OpaqueShebangError();
}

/**
 * Whether a by-path target is a native program, which holds no script for the guard to read. Only when the line has
 * not written that file: a write may have replaced what the disk holds, and the disk is all this looks at.
 */
export function runsNatively(target: ScriptTarget, ctx: ClassifyContext): boolean {
  if (target.byPath !== true || mayBeWritten(ctx, target.path)) return false;
  try {
    // Stat before open: opening a FIFO blocks the hook into its timeout, which fails open.
    const stat = statSync(target.path);
    if (!stat.isFile()) return false;
    const fd = openSync(target.path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const readAt = (position: number, length: number): Buffer => {
        const buf = Buffer.alloc(length);
        return buf.subarray(0, readSync(fd, buf, 0, length, position));
      };
      return isNativeProgram(readAt, stat.size);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

export const SOURCERS: ReadonlySet<string> = new Set(["source", "."]);
const INLINE_FLAG_RE = /^-[A-Za-z]*[ceEpm]$|^--(eval|print)(=|$)/;

/** The scripts a command runs by path; a shell runs every file on the descriptor it reads, as zsh's MULTIOS joins them. */
export function scriptTargets(cmd: SimpleCommand, home: string): ScriptTarget[] {
  const name = cmd.name;
  if (hasProcsubOperand(cmd)) return [...procsubTargets(cmd, home), ...scriptTargets(withoutProcsubOperands(cmd), home)];
  if (name !== null && SHELLS.has(name)) return shellTargets(cmd, home);
  const one = name === null ? null : scriptTarget(cmd, name, home);
  return one === null ? [] : [one];
}

function scriptTarget(cmd: SimpleCommand, name: string, home: string): ScriptTarget | null {
  if (SOURCERS.has(name)) return target(cmd, cmd.args[0], home, "shell");
  if (INTERPRETERS.has(name)) return target(cmd, firstOperand(cmd.args, INLINE_FLAG_RE, new Set()), home, "interpreter");
  return runsByPath(cmd.path) ? typedTarget(cmd, cmd.path, home) : null;
}

/** The kernel reads any file named with a `/`, whatever its suffix, and its `#!` line picks the interpreter; a bare name is read only as `x.sh`. */
function runsByPath(typed: string | null): typed is string {
  return typed !== null && (typed.includes("/") || typed.endsWith(".sh"));
}

/** `./x`, `~/bin/x.zsh`, `/tmp/x` or a bare `x.sh`, resolved as typed from the command's directory. */
function typedTarget(cmd: SimpleCommand, typed: string, home: string): ScriptTarget | null {
  const path = resolveValue(cmd.dir, typed, home);
  return path === null ? null : { path, kind: "shell", byPath: true };
}

/**
 * `bash x.sh`, or each file on the descriptor it runs: `bash < x.sh`, `bash /dev/stdin < x.sh`, `bash /dev/fd/3 3< x.sh`.
 * Under `-c` stdin is no script of the shell's own, but a command in the string may run it (`bash -c 'cat | bash' < x.sh`).
 * `bash -c` text and heredocs are already walked by `extractCommands`. A descriptor whose text the line cannot show is
 * refused.
 */
function shellTargets(cmd: SimpleCommand, home: string): ScriptTarget[] {
  const { runs, scriptFile, sources, unknowable } = shellStdin(shellOperands(cmd.args, cmd.name), cmd.redirects, false, cmd.inherited);
  if (unknowable) throw new UnknownStdinError();
  const script = scriptFile === null ? null : target(cmd, scriptFile, home, "shell");
  if (script !== null) return [script];
  const files = sources.flatMap((s) => (s.kind === "file" ? [target(cmd, s.target, home, "shell")].filter((t): t is ScriptTarget => t !== null) : []));
  return runs ? files : files.map((t) => ({ ...t, relayed: true }));
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
