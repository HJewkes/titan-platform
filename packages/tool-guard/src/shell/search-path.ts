import { MAY_LIST_CWD, NO_CWD, SEARCH_KEY, sourceOf } from "./assignment-source.js";
import type { AssignmentSource } from "./assignment-source.js";
import type { WordToken } from "./tokens.js";
import { assign, DECLARERS, trackVars } from "./vars.js";
import type { Assignment, TrackedCommand, Vars } from "./vars.js";

const SYSTEM_RE = /^\$\{?PATH\}?$/;
/** The working directory itself: an empty entry, `.`, `~+` or `$PWD`, with or without a trailing `/`. */
const CWD_RE = /^(?:\.\/?|~\+\/?|\$\{?PWD\}?\/?)?$/;
/** A literal directory under the working directory, which is not followed, as main follows none. */
const UNDER_CWD_RE = /^(?:~\+|\$\{?PWD\}?)\/[^$`]*$/;
/** `~`, `~/x` and `~user/x` are a home directory; `~+`, `~-` and `~N` name the working directory or a stack entry. */
const ABSOLUTE_RE = /^(?:\/|~(?:[A-Za-z_][\w.-]*)?(?:\/|$)|\$\{?HOME\}?(?:\/|$))/;
const RUNTIME_RE = /[$`~]/;
const DECLARED_RE = /^PATH(\+?)=(.*)$/s;

/** A `PATH` the line changed that may list the working directory, and the wrappers that look their command up on it. */
export interface SearchPath {
  wrappers?: string[];
}

/** `undefined`: the line never set `PATH`; else whether the one it set may list the working directory. */
type Held = boolean | undefined;

function held(vars: Vars): Held {
  return vars.has(SEARCH_KEY) ? vars.get(SEARCH_KEY) !== NO_CWD : undefined;
}

function keep(vars: Vars, cwd: boolean): void {
  vars.set(SEARCH_KEY, cwd ? MAY_LIST_CWD : NO_CWD);
}

/** A `..` segment may climb back to the working directory (`bin/..`), so a relative entry holding one is a guess at it. */
const PARENT_RE = /(?:^|\/)\.\.(?:\/|$)/;

/**
 * An entry that is the working directory, or one only run time knows (`$X`, `~-`), taken as a guess at it. Repeated `/`
 * and `/.` segments are dropped first, as the kernel reads `./.`, `.//` and `$PWD/.` as the directory itself.
 */
function mayBeCwd(entry: string): boolean {
  if (ABSOLUTE_RE.test(entry)) return false;
  const path = entry.replace(/\/{2,}/g, "/").replace(/\/\.(?=\/|$)/g, "");
  if (CWD_RE.test(path) || PARENT_RE.test(path)) return true;
  return !UNDER_CWD_RE.test(path) && RUNTIME_RE.test(path);
}

/** Whether `PATH=text` may list the working directory; the unchanged `$PATH` stands for the system's, which does not. */
function listsCwd(source: AssignmentSource, append: boolean, prior: Held): boolean {
  const before = prior === true;
  const listed = source.text.split(":");
  // `PATH+=:x` joins its first piece to the last entry, so an empty one there is no entry of its own.
  const entries = append && listed[0] === "" ? listed.slice(1) : listed;
  return source.subs || (append && before) || entries.some((entry) => (SYSTEM_RE.test(entry) ? before : mayBeCwd(entry)));
}

/** An assignment to `PATH` whose value text the walk holds; any other store to `PATH` or `path` may list the working directory. */
function applied(assignment: Assignment, prior: Held): boolean {
  const source = sourceOf(assignment);
  const plain = assignment[2] === undefined || assignment[2] === "append";
  if (assignment[0] !== "PATH" || source === undefined || !plain) return true;
  return listsCwd(source, assignment[2] === "append", prior);
}

const isPathName = (assignment: Assignment) => assignment[0] === "PATH" || assignment[0] === "path";

/** A standalone `PATH=.:$PATH`: the walk stores its dynamic value as unknown, so whether it lists the working directory comes from its text. */
export function assignStandalone(assigned: readonly Assignment[], vars: Vars): void {
  for (const assignment of assigned) {
    const before = held(vars);
    assign(vars, assignment);
    if (isPathName(assignment)) keep(vars, applied(assignment, before));
  }
}

/** `source` or `.` of any file, or an `eval` of text only run time knows, may store a `PATH` that lists the working directory. */
export function guessesPath(cmd: { name: string | null; args: WordToken[] }, evals: boolean): boolean {
  return cmd.name === "source" || cmd.name === "." || (evals && cmd.args.some((a) => a.dynamic));
}

export function guessPath(vars: Vars): void {
  keep(vars, true);
}

/** Carries the search path an `eval`'s text left in its walk back to the shell that ran it. */
export function adoptPath(from: Vars, to: Vars): void {
  if (from.has(SEARCH_KEY)) to.set(SEARCH_KEY, from.get(SEARCH_KEY) ?? null);
  else to.delete(SEARCH_KEY);
}

/** `declare -n`, `typeset -n` and `local -n` make a name an alias of another, so a later store through it may be `PATH`'s. */
const NAMEREF_RE = /^-[A-Za-z]*n/;
const NAMEREF_DECLARERS = new Set(["declare", "typeset", "local"]);

/** A nameref operand whose target is `PATH`, `path`, or only known at run time. */
function refersToPath(word: WordToken): boolean {
  const target = word.value.slice(word.value.indexOf("=") + 1);
  return word.dynamic || /^(?:PATH|path)(?:\[.*\])?$/.test(target);
}

/** Tracks a command's variable writes, then records `export PATH=.:$PATH` and the other declarations, whose operands are words, not assignments. */
export function trackCommand(cmd: TrackedCommand, vars: Vars): void {
  const before = held(vars);
  trackVars(cmd, vars);
  if (cmd.name !== null && NAMEREF_DECLARERS.has(cmd.name) && cmd.args.some((a) => NAMEREF_RE.test(a.value)) && cmd.args.some(refersToPath)) guessPath(vars);
  if (cmd.name === null || !DECLARERS.has(cmd.name)) return;
  for (const word of cmd.args) {
    const set = DECLARED_RE.exec(word.value);
    if (set !== null) keep(vars, listsCwd({ text: set[2] ?? "", subs: word.subs.length > 0 }, set[1] === "+", before));
  }
}

/** What the command's own lookups see: the line's `PATH`, then a prefix assignment. */
function effective(vars: Vars, assigned: readonly Assignment[]): Held {
  let cwd: Held = held(vars);
  for (const assignment of assigned) if (isPathName(assignment)) cwd = applied(assignment, cwd);
  return cwd;
}

/** A walk for the commands a shell or `find -exec` runs under this command, which inherit a prefix `PATH` through the environment. */
export function withPrefixPath<T extends { scope: { vars: Vars } }>(w: T, cmd: { assigned: readonly Assignment[] }): T {
  if (!cmd.assigned.some(isPathName)) return w;
  const vars = new Map(w.scope.vars);
  const cwd = effective(vars, cmd.assigned);
  if (cwd === undefined) vars.delete(SEARCH_KEY);
  else keep(vars, cwd);
  return { ...w, scope: { ...w.scope, vars } };
}

/**
 * Set when a command's bare name may be found in the working directory: the `PATH` the line stored before it, then a
 * prefix assignment (`PATH=.:$PATH s`, `env PATH=. s`), which holds for that command alone, may list it.
 */
export function searchPathOf(vars: Vars, cmd: { assigned: readonly Assignment[]; wrappers?: string[] }): { searchPath?: SearchPath } {
  if (effective(vars, cmd.assigned) !== true) return {};
  return { searchPath: cmd.wrappers ? { wrappers: cmd.wrappers } : {} };
}
