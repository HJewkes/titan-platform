import type { WordToken } from "./tokens.js";
import type { Vars } from "./vars.js";

/** Hidden key in a scope's variables: the entries of a `PATH` the line set, joined by `:`. No identifier can spell it. */
const KEY = "searchpath@";
/** An entry whose directory only run time knows. */
const UNKNOWN = "$?";
const PATH_WORD_RE = /^PATH(\+?)=(.*)$/s;
const SYSTEM_RE = /^\$\{?PATH\}?$/;
const CWD_RE = /^(?:\$\{?PWD\}?|\$\(pwd\)|`pwd`)(?=\/|$)/;
const ABSOLUTE_RE = /^(?:\/|~|\$\{?HOME\}?(?:\/|$))/;
const DYNAMIC_RE = /[$`]/;

/** What a changed `PATH` may search: the relative directories it lists, and whether some entry is only known at run time. */
export interface SearchPath {
  dirs: string[];
  unknown: boolean;
}

/**
 * Records a `PATH` the line sets (`PATH=.:$PATH s`, `export PATH=./bin:$PATH`, `env PATH=. s`). The unchanged `$PATH` stands for
 * the system's, whose entries the guard does not read, so only what the line adds is kept.
 */
export function notePath(words: readonly WordToken[], vars: Vars): void {
  for (const word of words) {
    const set = PATH_WORD_RE.exec(word.value);
    if (set === null) continue;
    const listed = (set[2] ?? "").split(":").flatMap((entry) => (SYSTEM_RE.test(entry) ? prior(vars) : [entry]));
    const entries = word.subs.length > 0 ? [...listed, UNKNOWN] : listed;
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

/** A command's `searchPath` field, or nothing when the line never set `PATH`. */
export function searchPathOf(vars: Vars): { searchPath?: SearchPath } {
  const held = vars.get(KEY);
  if (held === undefined || held === null) return {};
  const entries = held.split(":").map((entry) => entry.replace(CWD_RE, "."));
  const unknown = entries.some((entry) => entry === UNKNOWN || (DYNAMIC_RE.test(entry) && !ABSOLUTE_RE.test(entry)));
  return { searchPath: { dirs: entries.filter((entry) => !ABSOLUTE_RE.test(entry) && !DYNAMIC_RE.test(entry)), unknown } };
}
