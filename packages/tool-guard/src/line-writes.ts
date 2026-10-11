import type { SimpleCommand } from "./shell/commands.js";
import type { RedirectToken } from "./shell/lexer.js";
import { resolvePath } from "./shell/path.js";
import { commandOutput, SPLICING_SHELLS } from "./shell/sub-output.js";
import type { ClassifyContext } from "./types.js";

/** Redirects that open a file for writing; `<>` neither truncates nor, without an fd, takes stdout, so the disk text stands. */
const WRITE_OPS = new Set([">", ">|", ">>", "&>", "&>>", ">&"]);
/** `>&2` and `>&-` move or close a descriptor rather than name a file. */
const DUP_TARGET_RE = /^(\d+-?|-)$/;

interface FileWrite {
  path: string;
  append: boolean;
  /** What the command writes there, null when only known at run time. */
  text: string | null;
}

/**
 * The line state after `cmd` writes files through its redirects, so a script the same line runs next is read as the
 * line leaves it, not as the disk held it before the line ran. Text the guard cannot know replaces the file with null
 * (the D6 residual); an append of unknown text keeps what was known.
 */
export function afterWrites(cmd: SimpleCommand, line: ClassifyContext): ClassifyContext {
  const writes = fileWrites(cmd, line.home);
  if (writes.length === 0) return line;
  const known = new Map<string, string | null>();
  const current = (path: string) => (known.has(path) ? (known.get(path) ?? null) : diskText(line, path));
  for (const { path, append, text } of writes) {
    known.set(path, !append ? text : text === null ? current(path) : (current(path) ?? "") + text);
  }
  return { ...line, readScript: (path) => (known.has(path) ? (known.get(path) ?? null) : line.readScript(path)) };
}

function fileWrites(cmd: SimpleCommand, home: string): FileWrite[] {
  const stdout = cmd.redirects.filter((r) => takesStdout(r) || (isDup(r) && (r.fd === null || r.fd === "1"))).at(-1);
  return cmd.redirects.flatMap((r) => {
    if (!WRITE_OPS.has(r.op) || isDup(r)) return [];
    const path = resolvePath(cmd.dir, r.target, home);
    if (path === null) return [];
    const text = r === stdout ? printed(cmd) : takesStdout(r) ? "" : null;
    return [{ path, append: r.op.endsWith(">>"), text }];
  });
}

/** A file stdout points at; only the last such redirect receives the output, the earlier ones are just opened. */
function takesStdout(r: RedirectToken): boolean {
  if (!WRITE_OPS.has(r.op) || isDup(r)) return false;
  return r.op.startsWith("&") || r.fd === null || r.fd === "1";
}

function isDup(r: RedirectToken): boolean {
  return r.op === ">&" && r.target !== null && !r.target.dynamic && DUP_TARGET_RE.test(r.target.value);
}

/** Each shell's output is one reading, so where bash and zsh print differently the file holds both, one per line. */
function printed(cmd: SimpleCommand): string | null {
  const readings = SPLICING_SHELLS.map((shell) => commandOutput(cmd.name, cmd.args, cmd.redirects, shell));
  if (readings.some((r) => r === null)) return null;
  return [...new Set(readings)].join("\n");
}

function diskText(line: ClassifyContext, path: string): string | null {
  try {
    return line.readScript(path);
  } catch {
    return null;
  }
}
