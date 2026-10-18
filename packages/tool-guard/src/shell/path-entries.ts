import { SHELL_BUILTINS } from "./builtins.js";
import type { WordToken } from "./tokens.js";
import type { Assignment, Vars } from "./vars.js";
import { tildeStarts } from "./word-build.js";

/** POSIX's special builtins, whose prefix assignments a POSIX-mode shell such as `sh` keeps after they return. */
const SPECIAL_BUILTINS = new Set([":", ".", "break", "continue", "eval", "exec", "exit", "export", "readonly", "return", "set", "shift", "times", "trap", "unset"]);

/** The rest of a directory after its lead: literal path characters only, so no expansion, glob or quote is left in it. */
const LITERAL_REST_RE = /^(?:\/[^$`\\*?[(){}]*)?$/;

/**
 * Whether a literal path stays off the working directory: a `..` may climb out of a symlink to anywhere, and /proc
 * and /dev reach the working directory through the kernel, however many `/` and `.` segments spell the way there.
 */
function staysOffCwd(path: string): boolean {
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  return !segments.includes("..") && !(path.startsWith("/") && (segments[0] === "proc" || segments[0] === "dev"));
}

/** A `HOME` a `~` on PATH may stand for: a literal absolute directory other than the working directory. */
function fixedHome(value: string | null | undefined): boolean {
  return value?.startsWith("/") === true && staysOffCwd(value);
}

/** An assignment's value as the lexer read it: the text, and which of its `~` and `$NAME` the shell really expands. */
export interface RawValue {
  text: string;
  tildes: number[];
  refs: Array<{ name: string; start: number; end: number }>;
}

/** The value of the assignment word `w` after its first `from` characters, the `NAME=` they hold. */
export function rawValue(w: WordToken, from: number): RawValue {
  const refs = w.refs.filter((ref) => ref.start >= from).map((ref) => ({ ...ref, start: ref.start - from, end: ref.end - from }));
  return { text: w.value.slice(from), tildes: tildeStarts(w).flatMap((at) => (at >= from ? [at - from] : [])), refs };
}

/**
 * The absolute directories an assignment puts on `PATH`, or null when it may put anything else there. The text is
 * read after quote removal, so an entry is approved only from what the lexer saw the shell expand, and anything not
 * approved fails closed: `'~/b'`, `\~/b`, `~"/b"` and `'$HOME/b'` all stay literal and name a directory under the
 * working directory. An entry is approved when it is a literal absolute path, or a `~` or `$HOME` the shell expands
 * followed by `/` and a literal path, under a `HOME` that is fixed; either passes `staysOffCwd`. A `$PATH` the shell
 * expands keeps the old value. An append's leading `:` is its separator, not an empty entry.
 */
export function safePathDirs(raw: RawValue, append: boolean, vars: Vars, homeSet = false): string[] | null {
  const homeSafe = !homeSet && (!vars.has("HOME") || fixedHome(vars.get("HOME")));
  const dirs: string[] = [];
  let start = append && raw.text.startsWith(":") ? 1 : 0;
  for (const entry of raw.text.slice(start).split(":")) {
    const lead = leadAt(raw, start);
    start += entry.length + 1;
    if (lead?.name === "PATH" && lead.length === entry.length) continue;
    const dir = approvedDir(entry, lead?.name === "HOME" ? lead.length : 0, homeSafe);
    if (dir === null) return null;
    dirs.push(dir);
  }
  return dirs;
}

/**
 * The tilde (as `HOME`) or variable the shell expands at `start`. The lexer keeps a ref only for a plain `$NAME` or
 * `${NAME}`, so an operator such as `${HOME:+.}` is no lead.
 */
function leadAt(raw: RawValue, start: number): { name: string; length: number } | null {
  if (raw.tildes.includes(start)) return { name: "HOME", length: 1 };
  const ref = raw.refs.find((r) => r.start === start);
  return ref ? { name: ref.name, length: ref.end - ref.start } : null;
}

/** The directory an entry names, kept as `~` under a home lead `homeLead` characters long; null unless the contract above approves it. */
function approvedDir(entry: string, homeLead: number, homeSafe: boolean): string | null {
  const rest = entry.slice(homeLead);
  if (homeLead > 0 ? !homeSafe : !entry.startsWith("/")) return null;
  const dir = homeLead > 0 ? `~${rest}` : rest;
  return LITERAL_REST_RE.test(rest) && staysOffCwd(dir) ? dir.replace(/(?<=.)\/$/, "") : null;
}

/**
 * Whether a command's prefix may reach commands other than the one it is written on: a bare name may be a function,
 * whose body the walk reads where it is defined, and a special builtin leaves the prefix in a POSIX-mode shell.
 */
export function prefixOutlives(name: string | null): boolean {
  if (name === null) return false;
  return SPECIAL_BUILTINS.has(name) || (!name.includes("/") && !SHELL_BUILTINS.has(name));
}

/** Whether a prefix sets `HOME` to anything but a literal absolute directory, so a `~` on PATH may name the working directory. */
export function prefixHomeUnsafe(assigned: Assignment[]): boolean {
  return assigned.some(([name, value, kind]) => name === "HOME" && kind !== "hidden" && !fixedHome(value));
}

/** What a command's own `NAME=value` prefix does to the `PATH` it runs under. */
export function prefixPath(assigned: Assignment[], isPath: (name: string) => boolean, vars: Vars): { unsafe: boolean; dirs: string[] } {
  const dirs: string[] = [];
  const homeSet = assigned.some(([name]) => name === "HOME");
  for (const [name, , kind, , raw] of assigned) {
    if (kind === "hidden" || !isPath(name)) continue;
    const safe = kind === undefined || kind === "append" ? (raw === undefined ? null : safePathDirs(raw, kind === "append", vars, homeSet)) : null;
    if (safe === null) return { unsafe: true, dirs };
    dirs.push(...safe);
  }
  return { unsafe: false, dirs };
}
