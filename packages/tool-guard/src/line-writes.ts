import type { SimpleCommand } from "./shell/commands.js";
import type { RedirectToken } from "./shell/lexer.js";
import { resolvePath } from "./shell/path.js";
import { commandOutput, SPLICING_SHELLS } from "./shell/sub-output.js";
import { ReadingLimitError } from "./shell/unsure-readings.js";
import type { ClassifyContext } from "./types.js";

/** Redirects that open a file for writing; `<>` neither truncates nor, without an fd, takes stdout, so the disk text stands. */
const WRITE_OPS = new Set([">", ">|", ">>", "&>", "&>>", ">&"]);
/** `>&2` and `>&-` move or close a descriptor rather than name a file. */
const DUP_TARGET_RE = /^(\d+-?|-)$/;
/** Each conditional append doubles a file's readings; past this many the line is refused rather than read. */
export const MAX_WRITTEN_READINGS = 16;

/**
 * Every text a script at `path` may hold at this point of the line: what the disk held, and what each earlier write on
 * the line may have left there.
 */
export function scriptReadings(ctx: ClassifyContext, path: string): string[] {
  if (ctx.scriptReadings) return ctx.scriptReadings(path);
  const text = diskText(ctx, path);
  return text === null ? [] : [text];
}

/**
 * The line state after `cmd` writes literal text to a file, so a script the same line runs next is also read as the
 * write leaves it. A write only ever adds a reading: it may sit behind `&&`, in a body that never runs, in the
 * background or under noclobber, so what the file held before stays a reading too. A write whose text is only known at
 * run time adds nothing (the D6 residual).
 */
export function afterWrites(cmd: SimpleCommand, line: ClassifyContext): ClassifyContext {
  const target = stdoutFile(cmd.redirects);
  const path = target ? resolvePath(cmd.dir, target.target, line.home) : null;
  const text = path === null ? null : written(cmd);
  if (path === null || !text) return line;
  const prior = scriptReadings(line, path);
  const added = target?.op.endsWith(">>") && prior.length > 0 ? prior.map((p) => p + text) : [text];
  const readings = [...new Set([...prior, ...added])];
  if (readings.length > MAX_WRITTEN_READINGS) throw new ReadingLimitError();
  return { ...line, scriptReadings: (p) => (p === path ? readings : scriptReadings(line, p)) };
}

/** The file stdout ends at: only the last redirect of stdout receives the output, and a dup sends it to no file. */
function stdoutFile(redirects: RedirectToken[]): RedirectToken | null {
  const last = redirects.filter((r) => WRITE_OPS.has(r.op) && (r.op.startsWith("&") || r.fd === null || r.fd === "1")).at(-1);
  return !last || isDup(last) ? null : last;
}

function isDup(r: RedirectToken): boolean {
  return r.op === ">&" && r.target !== null && !r.target.dynamic && DUP_TARGET_RE.test(r.target.value);
}

/** Each shell's output is one reading, so where bash and zsh print differently the file holds both, one per line. */
function written(cmd: SimpleCommand): string | null {
  const readings = SPLICING_SHELLS.map((shell) => commandOutput(cmd.name, cmd.args, cmd.redirects, shell));
  if (readings.some((r) => r === null)) return null;
  return [...new Set(readings)].join("\n");
}

function diskText(ctx: ClassifyContext, path: string): string | null {
  try {
    return ctx.readScript(path);
  } catch {
    return null;
  }
}
