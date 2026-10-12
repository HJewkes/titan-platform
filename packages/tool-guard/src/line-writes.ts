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
/**
 * Each conditional append doubles a file's readings. Past this many a file stops tracking them, and a script run from it
 * refuses the line; a file nothing runs, such as a PR body built up with appends, costs nothing.
 */
const MAX_WRITTEN_READINGS = 16;

/**
 * Every text a script at `path` may hold at this point of the line: what the disk held, and what each earlier write on
 * the line may have left there. Throws `ReadingLimitError` when the line left more than it tracks.
 */
export function scriptReadings(ctx: ClassifyContext, path: string): string[] {
  const readings = trackedReadings(ctx, path);
  if (readings === null) throw new ReadingLimitError();
  return readings;
}

/** The readings of `path`, null once the line has left more than `MAX_WRITTEN_READINGS`. */
function trackedReadings(ctx: ClassifyContext, path: string): string[] | null {
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
  const targets = stdoutFiles(cmd.redirects);
  const text = targets.length === 0 ? null : written(cmd);
  if (!text) return line;
  return targets.reduce((ctx, target) => {
    const path = resolvePath(cmd.dir, target.target, line.home);
    return path === null ? ctx : withFileWrite(ctx, path, text, target.op.endsWith(">>"));
  }, line);
}

/** The write lands in the state an `&&` chain falls back to as well, since the command ran whether or not the chain breaks later. */
function withFileWrite(line: ClassifyContext, path: string, text: string, append: boolean): ClassifyContext {
  const readings = withWrite(trackedReadings(line, path), text, append);
  const next: ClassifyContext = { ...line, scriptReadings: (p) => (p === path ? readings : trackedReadings(line, p)) };
  const trust = line.chainTrust;
  return trust ? { ...next, chainTrust: { ...trust, fallback: withFileWrite(trust.fallback, path, text, append) } } : next;
}

function withWrite(prior: string[] | null, text: string, append: boolean): string[] | null {
  if (prior === null) return null;
  const added = append && prior.length > 0 ? prior.map((p) => p + text) : [text];
  const readings = [...new Set([...prior, ...added])];
  return readings.length > MAX_WRITTEN_READINGS ? null : readings;
}

/**
 * The files stdout is written to. Bash sends it to the last stdout redirect only, and a dup there sends it to no file;
 * zsh's MULTIOS, on by default, copies it to every one, a dup included, so each file is a reading.
 */
function stdoutFiles(redirects: RedirectToken[]): RedirectToken[] {
  return redirects.filter((r) => WRITE_OPS.has(r.op) && (r.op.startsWith("&") || r.fd === null || r.fd === "1") && !isDup(r));
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
