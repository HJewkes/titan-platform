import type { WordToken } from "./tokens.js";
import type { Vars } from "./vars.js";

/** Hidden key in a scope's variables: the entries of a `PATH` the line set, joined by `:`. No identifier can spell it. */
const KEY = "searchpath@";
const PATH_WORD_RE = /^PATH(\+?)=(.*)$/s;
const SYSTEM_RE = /^\$\{?PATH\}?$/;
const CWD_RE = /^(?:\$\{?PWD\}?|\$\(pwd\)|`pwd`)(?=\/|$)/;

/**
 * Records a `PATH` the line sets (`PATH=.:$PATH s`, `export PATH=./bin:$PATH`, `env PATH=. s`). The unchanged `$PATH` stands for
 * the system's, whose entries the guard does not read, so only what the line adds is kept.
 */
export function notePath(words: readonly WordToken[], vars: Vars): void {
  for (const word of words) {
    const set = PATH_WORD_RE.exec(word.value);
    if (set === null) continue;
    const entries = (set[2] ?? "").split(":").flatMap((entry) => (SYSTEM_RE.test(entry) ? prior(vars) : [entry]));
    const kept = set[1] === "+" ? [...prior(vars), ...entries] : entries;
    if (kept.length === 0) vars.delete(KEY);
    else vars.set(KEY, kept.join(":"));
  }
}

function prior(vars: Vars): string[] {
  const held = vars.get(KEY);
  return held === undefined || held === null ? [] : held.split(":");
}

/** Whether a command word names a file the kernel or a shell reads as a script: any word with a `/`, or `x.sh`. */
export function namesScript(cmd: { path: string | null; name: string | null }): boolean {
  return cmd.path?.includes("/") === true || cmd.name?.endsWith(".sh") === true;
}

/** A command's `searchDirs` field, or nothing. */
export function searchDirsOf(vars: Vars): { searchDirs?: string[] } {
  const dirs = relativeSearchDirs(vars);
  return dirs ? { searchDirs: dirs } : {};
}

/**
 * The directories a changed `PATH` may find a bare command name in that depend on where the command runs: an empty entry,
 * `.` or any relative one. An absolute entry names no script this line can plant, and a dynamic one is not followed.
 */
export function relativeSearchDirs(vars: Vars): string[] | undefined {
  const held = vars.get(KEY);
  if (held === undefined || held === null) return undefined;
  const dirs = held.split(":").map((entry) => entry.replace(CWD_RE, ".")).filter((entry) => !entry.startsWith("/") && !entry.startsWith("~") && !/[$`]/.test(entry));
  return dirs.length === 0 ? undefined : dirs;
}
