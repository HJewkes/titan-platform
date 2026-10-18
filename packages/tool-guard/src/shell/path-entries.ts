import { SHELL_BUILTINS } from "./builtins.js";
import type { Assignment, Vars } from "./vars.js";

/** POSIX's special builtins, whose prefix assignments a POSIX-mode shell such as `sh` keeps after they return. */
const SPECIAL_BUILTINS = new Set([":", ".", "break", "continue", "eval", "exec", "exit", "export", "readonly", "return", "set", "shift", "times", "trap", "unset"]);

const SELF_RE = /^\$(?:PATH|\{PATH\})$/;
/** A literal absolute directory, or one under `~` or `$HOME`, which the walk keeps as `~`. */
const LITERAL_DIR_RE = /^(?:\/|~(?:\/|$)|\$(?:HOME|\{HOME\})(?:\/|$))[^$`\\*?[(){}]*$/;
const HOME_RE = /^(?:\$(?:HOME|\{HOME\})|~)/;

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

/**
 * The absolute directories an assignment puts on `PATH`, or null when it puts anything else there: an empty entry
 * and a relative one both name the working directory, and an entry built at run time can name any. The part of the
 * old value is kept as it is (`$PATH`), so only the entries the assignment adds are read. An append's leading `:` is
 * its separator, not an empty entry.
 */
export function safePathDirs(raw: string, append: boolean, vars: Vars, homeSet = false): string[] | null {
  const homeSafe = !homeSet && (!vars.has("HOME") || fixedHome(vars.get("HOME")));
  const dirs: string[] = [];
  for (const entry of (append && raw.startsWith(":") ? raw.slice(1) : raw).split(":")) {
    if (SELF_RE.test(entry)) continue;
    if (!LITERAL_DIR_RE.test(entry) || !staysOffCwd(entry) || (HOME_RE.test(entry) && !homeSafe)) return null;
    dirs.push(entry.replace(HOME_RE, "~").replace(/(?<=.)\/$/, ""));
  }
  return dirs;
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
