import type { Assignment, Vars } from "./vars.js";

const SELF_RE = /^\$(?:PATH|\{PATH\})$/;
/** A literal absolute directory, or one under `~` or `$HOME`, which the walk keeps as `~`. */
const LITERAL_DIR_RE = /^(?:\/|~(?:\/|$)|\$(?:HOME|\{HOME\})(?:\/|$))[^$`\\*?[(){}]*$/;
const HOME_RE = /^\$(?:HOME|\{HOME\})/;

/**
 * The absolute directories an assignment puts on `PATH`, or null when it puts anything else there: an empty entry
 * and a relative one both name the working directory, and an entry built at run time can name any. The part of the
 * old value is kept as it is (`$PATH`), so only the entries the assignment adds are read. An append's leading `:` is
 * its separator, not an empty entry.
 */
export function safePathDirs(raw: string, append: boolean, vars: Vars): string[] | null {
  const homeSafe = !vars.has("HOME") || (vars.get("HOME") ?? "").startsWith("/");
  const dirs: string[] = [];
  for (const entry of (append && raw.startsWith(":") ? raw.slice(1) : raw).split(":")) {
    if (SELF_RE.test(entry)) continue;
    if (!LITERAL_DIR_RE.test(entry) || (HOME_RE.test(entry) && !homeSafe)) return null;
    dirs.push(entry.replace(HOME_RE, "~").replace(/(?<=.)\/$/, ""));
  }
  return dirs;
}

/** What a command's own `NAME=value` prefix does to the `PATH` it runs under. */
export function prefixPath(assigned: Assignment[], isPath: (name: string) => boolean, vars: Vars): { unsafe: boolean; dirs: string[] } {
  const dirs: string[] = [];
  for (const [name, , kind, , raw] of assigned) {
    if (kind === "hidden" || !isPath(name)) continue;
    const safe = kind === undefined || kind === "append" ? (raw === undefined ? null : safePathDirs(raw, kind === "append", vars)) : null;
    if (safe === null) return { unsafe: true, dirs };
    dirs.push(...safe);
  }
  return { unsafe: false, dirs };
}
