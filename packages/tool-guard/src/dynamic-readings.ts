import type { SimpleCommand } from "./shell/commands.js";
import { parseGit } from "./shell/git.js";
import { unwrap } from "./shell/unwrap.js";
import type { Family } from "./types.js";

/** Whether `cmd` runs a command whose name is only known at run time, as in `"$G" push origin HEAD:main`. */
export function hasDynamicName(cmd: SimpleCommand): boolean {
  return cmd.name === null && cmd.args[0]?.dynamic === true;
}

/**
 * The words after a dynamic command word read as each command name a family lists. The family's own
 * classification of a reading is the verdict, so a word naming no guarded verb (`"$EDITOR" file`) reads as nothing.
 */
export function namedReadings(cmd: SimpleCommand, families: readonly Family[]): SimpleCommand[] {
  const names = new Set(families.flatMap((f) => [...(f.names ?? [])]));
  const readings = [...names].map((name) => ({ ...cmd, name, path: name, args: cmd.args.slice(1) }));
  return [...readings.filter(namesItsHost), ...splitGit(cmd)];
}

/**
 * An unquoted word may split into `git -C ../x`, which changes where git runs, so a push or merge after it also
 * reads as `git <word> ...`, which fails closed as `git $A push` does.
 */
function splitGit(cmd: SimpleCommand): SimpleCommand[] {
  const word = cmd.args[0];
  const sub = parseGit(cmd.args.slice(1), null).sub;
  const splits = word !== undefined && (!word.quoted || word.unquotedExpansion);
  return splits && (sub === "push" || sub === "merge") ? [{ ...cmd, name: "git", path: "git" }] : [];
}

const PORT_RE = /^\d+(?:-\d+)?$/;
const HOST_RE = /\.|^localhost$/i;
const REMOTE_RE = /@|::|^(?:scp|sftp|rsync|ssh):\/\//i;
const PORT_TAKERS = new Set(["nc", "ncat", "netcat", "telnet"]);
const REMOTE_TAKERS = new Set(["sftp", "scp", "rsync"]);

/**
 * These commands take a bare word as a host (`nc host`, `sftp host`, `rsync a b:c`), so any word at all would
 * read as one. A reading is kept only when the words also carry what marks a host in that command's syntax:
 * a host-shaped word followed by a port for the socket tools, a `user@host`, `host::module` or an `scp://`-style URL operand for the copy tools.
 */
function namesItsHost(reading: SimpleCommand): boolean {
  const words = reading.args.filter((a) => !a.dynamic).map((a) => a.value);
  if (PORT_TAKERS.has(reading.name ?? "")) return words.some((w, i) => HOST_RE.test(w) && PORT_RE.test(words[i + 1] ?? ""));
  return !REMOTE_TAKERS.has(reading.name ?? "") || words.some((w) => REMOTE_RE.test(w));
}

/** The words after a dynamic command word read as the command they name when they start with a wrapper (`"$P" pnpm publish`). */
export function wrappedReading(cmd: SimpleCommand): SimpleCommand | null {
  const run = cmd.args.length > 1 ? unwrap(cmd.args.slice(1)) : null;
  return run?.name ? { ...cmd, name: run.name, path: run.path, args: run.args } : null;
}
