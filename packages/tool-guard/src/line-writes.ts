import { namedWrites } from "./command-writes.js";
import type { NamedWrite, Presence } from "./command-writes.js";
import type { SimpleCommand } from "./shell/commands.js";
import type { RedirectToken } from "./shell/lexer.js";
import { resolvePath } from "./shell/path.js";
import { commandOutput, SPLICING_SHELLS } from "./shell/sub-output.js";
import { UnreadableScriptError, UntrackedWriteError } from "./shell/unsure-readings.js";
import type { ClassifyContext } from "./types.js";

/** Redirects that only read; they write nothing whatever their target. */
const READ_OPS = new Set(["<", "<<", "<<-", "<<<"]);
/** Redirects of stdout alone, modelled when their fd is stdout's. */
const STDOUT_OPS = new Set([">", ">|", ">>"]);
/** Redirects of stdout and stderr together, modelled when no fd is given. */
const BOTH_OPS = new Set(["&>", "&>>", ">&"]);
/** Every redirect that opens a file it may write. */
const FILE_OPS = new Set([">", ">|", ">>", "&>", "&>>", ">&", "<>", "<&"]);
/** The ops `redirectEffect` names; any other op the lexer may one day emit is read as a write anywhere. */
export const REDIRECT_OPS: ReadonlySet<string> = new Set([...READ_OPS, ...FILE_OPS]);
/** `>&2` and `>&-` move or close a descriptor rather than name a file. */
const DUP_TARGET_RE = /^(\d+-?|-)$/;

/**
 * What a redirect may do to a file: nothing, write stdout the model reproduces, write text it does not, or write a file it
 * cannot name. Only `stdout` is modelled; anything not proven read-only counts as a write.
 */
type Effect = { kind: "none" } | { kind: "stdout"; path: string; append: boolean } | { kind: "untracked"; path: string } | { kind: "anywhere" };

const NONE: Effect = { kind: "none" };
const ANYWHERE: Effect = { kind: "anywhere" };

/**
 * One total table, read top to bottom. An unquoted target starting with `!` is zsh's clobber spelling (`>! f`, `>>!f`,
 * `&>! f`, `>&! f`), whose real target the token does not hold, and bash writes a file named `!` there instead.
 */
function redirectEffect(r: RedirectToken, dir: string | null, home: string): Effect {
  if (READ_OPS.has(r.op)) return NONE;
  const target = r.target;
  if (target === null || target.dynamic || (!target.quoted && target.value.startsWith("!"))) return ANYWHERE;
  if ((r.op === "<&" || r.op === ">&") && DUP_TARGET_RE.test(target.value)) return NONE;
  const path = resolvePath(dir, target, home);
  if (path === null) return ANYWHERE;
  if (STDOUT_OPS.has(r.op) && (r.fd === null || r.fd === "1")) return { kind: "stdout", path, append: r.op === ">>" };
  if (BOTH_OPS.has(r.op) && (r.fd === null || (r.op === ">&" && r.fd === "1"))) return { kind: "stdout", path, append: r.op === "&>>" };
  if (FILE_OPS.has(r.op)) return { kind: "untracked", path };
  return ANYWHERE;
}

/**
 * Each conditional append doubles a file's readings. Past this many a file stops tracking them, and a script run from it
 * refuses the line; a file nothing runs, such as a PR body built up with appends, costs nothing.
 */
const MAX_WRITTEN_READINGS = 16;

/**
 * Every text a script at `path` may hold at this point of the line: what the disk held, and what each earlier write on
 * the line may have left there. Throws `UntrackedWriteError` when the line wrote it in a way the guard does not follow.
 */
export function scriptReadings(ctx: ClassifyContext, path: string): string[] {
  const readings = trackedReadings(ctx, path);
  if (readings === null) throw new UntrackedWriteError();
  return readings;
}

/**
 * Whether an earlier write on the line may have changed what `path` holds: it wrote that path with text other than what
 * the disk holds, or wrote something the guard cannot place. A write to any other path, `>/dev/null` or `2>log`, does not.
 */
export function mayBeWritten(ctx: ClassifyContext, path: string): boolean {
  if (ctx.scriptReadings === undefined) return false;
  let readings: string[] | null;
  try {
    readings = ctx.scriptReadings(path);
  } catch {
    return false;
  }
  if (readings === null) return true;
  try {
    const onDisk = trackedReadings({ ...ctx, scriptReadings: undefined }, path);
    return onDisk === null || onDisk.length !== readings.length || onDisk.some((text, i) => text !== readings[i]);
  } catch {
    return true;
  }
}

/** The readings of `path`, null once the line wrote it untracked or left more than `MAX_WRITTEN_READINGS`. */
function trackedReadings(ctx: ClassifyContext, path: string): string[] | null {
  if (ctx.scriptReadings) return ctx.scriptReadings(path);
  const text = diskText(ctx, path);
  return text === null ? [] : [text];
}

/**
 * The line state after `cmd`'s redirects, so a script the same line runs next is read as the line may leave it. A
 * modelled write only adds a reading: it may sit behind `&&`, in a body that never runs, in the background or under
 * noclobber, so what the file held stays a reading too. Every stdout target gets the text, as zsh's MULTIOS copies
 * stdout to each. A write the model does not reproduce, its text or its target, leaves the file untracked.
 */
export function afterWrites(cmd: SimpleCommand, line: ClassifyContext): ClassifyContext {
  const afterRedirects = withRedirects(cmd, line);
  const presence = (path: string): Presence => presenceOf(afterRedirects, path);
  return namedWrites(cmd, presence, line.home).reduce(withNamed, afterRedirects);
}

function withRedirects(cmd: SimpleCommand, line: ClassifyContext): ClassifyContext {
  const effects = cmd.redirects.map((r) => redirectEffect(r, cmd.dir, line.home));
  if (effects.every((e) => e.kind === "none")) return line;
  const text = effects.some((e) => e.kind === "stdout") ? written(cmd) : null;
  return effects.reduce((ctx, effect) => withEffect(ctx, effect, text), line);
}

/** A file written by name (tee, cp, mv, install, ln, dd): a copy adds the source's readings, the rest leave the target untracked. */
function withNamed(line: ClassifyContext, write: NamedWrite): ClassifyContext {
  if (write.kind === "anywhere") return withReadings(line, null, () => null);
  if (write.kind === "untracked") return withReadings(line, write.path, () => null);
  if (write.kind === "tree") return withReadings(line, write.path, () => null, true);
  const from = write.from;
  return withReadings(line, write.to, (prior) => withCopy(prior, trackedReadings(line, from)));
}

function withCopy(prior: string[] | null, copied: string[] | null): string[] | null {
  if (prior === null || copied === null) return null;
  const readings = [...new Set([...prior, ...copied])];
  return readings.length > MAX_WRITTEN_READINGS ? null : readings;
}

/** Whether `path` holds a file the line can read, nothing, or something it cannot (a directory, a file too long, an untracked write). */
function presenceOf(line: ClassifyContext, path: string): Presence {
  try {
    const readings = trackedReadings(line, path);
    return readings === null ? "other" : readings.length === 0 ? "absent" : "file";
  } catch (error) {
    if (!(error instanceof UnreadableScriptError)) throw error;
    return error.absent ? "absent" : "other";
  }
}

function withEffect(line: ClassifyContext, effect: Effect, text: string | null): ClassifyContext {
  if (effect.kind === "none") return line;
  if (effect.kind === "anywhere") return withReadings(line, null, () => null);
  if (effect.kind === "untracked" || text === null) return withReadings(line, effect.path, () => null);
  return withReadings(line, effect.path, (prior) => withWrite(prior, text, effect.append));
}

/**
 * `path`'s readings replaced by `update` of them, or every path's made unknown when `path` is null; with `tree`, everything under
 * `path` is made unknown too. The write lands in
 * the state an `&&` chain falls back to as well, since the command ran whether or not the chain breaks later.
 */
function withReadings(line: ClassifyContext, path: string | null, update: (prior: string[] | null) => string[] | null, tree = false): ClassifyContext {
  const readings = path === null ? null : update(priorReadings(line, path));
  const hits = (p: string): boolean => p === path || (tree && path !== null && p.startsWith(path === "/" ? path : `${path}/`));
  const next: ClassifyContext = { ...line, scriptReadings: (p) => (path === null ? null : hits(p) ? (p === path ? readings : null) : trackedReadings(line, p)) };
  const trust = line.chainTrust;
  return trust ? { ...next, chainTrust: { ...trust, fallback: withReadings(trust.fallback, path, update, tree) } } : next;
}

/** What `path` may hold before a write; one that is there and the guard cannot read in full leaves the file untracked, since a shell runs the rest. */
function priorReadings(line: ClassifyContext, path: string): string[] | null {
  try {
    return trackedReadings(line, path);
  } catch (error) {
    if (!(error instanceof UnreadableScriptError)) throw error;
    return error.absent ? [] : null;
  }
}

function withWrite(prior: string[] | null, text: string, append: boolean): string[] | null {
  if (prior === null) return null;
  const added = append && prior.length > 0 ? prior.map((p) => p + text) : [text];
  const readings = [...new Set([...prior, ...added])];
  return readings.length > MAX_WRITTEN_READINGS ? null : readings;
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
  } catch (error) {
    if (error instanceof UnreadableScriptError) throw error;
    return null;
  }
}
