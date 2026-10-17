import { SEARCH_KEY, SOFT_ENTRY, sourceOf, UNKNOWN_ENTRY } from "./assignment-source.js";
import type { AssignmentSource } from "./assignment-source.js";
import type { WordToken } from "./tokens.js";
import { assign, DECLARERS, trackVars } from "./vars.js";
import type { Assignment, TrackedCommand, Vars } from "./vars.js";

const SYSTEM_RE = /^\$\{?PATH\}?$/;
const CWD_RE = /^(?:\$\{?PWD\}?|\$\(pwd\)|`pwd`)(?=\/|$)/;
/** `~`, `~/x` and `~user/x` are a home directory; `~+`, `~-` and `~N` name the working directory or a stack entry. */
const ABSOLUTE_RE = /^(?:\/|~(?:[A-Za-z_][\w.-]*)?(?:\/|$)|\$\{?HOME\}?(?:\/|$))/;
const DYNAMIC_RE = /[$`]/;
const DECLARED_RE = /^PATH(\+?)=(.*)$/s;

/** What a changed `PATH` may search: the relative directories it lists, whether some entry is only known at run time, and the wrappers that look their command up on it. */
export interface SearchPath {
  dirs: string[];
  unknown: boolean;
  /** Its only relative entry is a guess at the working directory, so a file there is read but a missing one is no reason to refuse. */
  soft?: true;
  wrappers?: string[];
}

/** `undefined`: the line never set `PATH`; null: a store the walk cannot read; else the entries it set. */
type Held = string[] | null | undefined;

function held(vars: Vars): Held {
  const value = vars.get(SEARCH_KEY);
  return typeof value === "string" ? value.split(":") : value;
}

/** The entries `PATH=text` leaves, given what it replaces or extends; the unchanged `$PATH` stands for the system's, which the guard does not read. */
function entriesOf(source: AssignmentSource, append: boolean, prior: Held): string[] {
  const listed = source.text.split(":");
  const reads = append || listed.some((entry) => SYSTEM_RE.test(entry));
  const before = prior ?? [];
  const entries = listed.flatMap((entry) => (SYSTEM_RE.test(entry) ? before : [entry]));
  const unread = (prior === null && reads) || source.subs ? [UNKNOWN_ENTRY] : [];
  return append ? [...before, ...entries, ...unread] : [...entries, ...unread];
}

/** An assignment to `PATH` whose value text the walk holds; any other store to `PATH` or `path` leaves its entries unknown. */
function applied(assignment: Assignment, prior: Held): string[] {
  const source = sourceOf(assignment);
  const plain = assignment[2] === undefined || assignment[2] === "append";
  if (assignment[0] !== "PATH" || source === undefined || !plain) return [UNKNOWN_ENTRY];
  return entriesOf(source, assignment[2] === "append", prior);
}

function keep(vars: Vars, entries: string[]): void {
  if (entries.length > 0) vars.set(SEARCH_KEY, entries.join(":"));
  else vars.delete(SEARCH_KEY);
}

const isPathName = (assignment: Assignment) => assignment[0] === "PATH" || assignment[0] === "path";

/** A standalone `PATH=.:$PATH`: the walk stores its dynamic value as unknown, so the entries come from its text. */
export function assignStandalone(assigned: readonly Assignment[], vars: Vars): void {
  for (const assignment of assigned) {
    const before = held(vars);
    assign(vars, assignment);
    if (isPathName(assignment)) keep(vars, applied(assignment, before));
  }
}

/** An `eval` of text only known at run time may store a `PATH` that lists the working directory. */
export function markPathSoft(vars: Vars): void {
  const before = held(vars);
  if (before !== null) vars.set(SEARCH_KEY, [...(before ?? []), SOFT_ENTRY].join(":"));
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

/** Tracks a command's variable writes, then records `export PATH=./bin:$PATH` and the other declarations, whose operands are words, not assignments. */
export function trackCommand(cmd: TrackedCommand, vars: Vars): void {
  const before = held(vars);
  trackVars(cmd, vars);
  if (cmd.name !== null && NAMEREF_DECLARERS.has(cmd.name) && cmd.args.some((a) => NAMEREF_RE.test(a.value)) && cmd.args.some(refersToPath)) vars.set(SEARCH_KEY, null);
  if (cmd.name === null || !DECLARERS.has(cmd.name)) return;
  for (const word of cmd.args) {
    const set = DECLARED_RE.exec(word.value);
    if (set !== null) keep(vars, entriesOf({ text: set[2] ?? "", subs: word.subs.length > 0 }, set[1] === "+", before));
  }
}

/** Whether a command word names a file the kernel or a shell reads as a script: any word with a `/`, or `x.sh`. */
export function namesScript(cmd: { path: string | null; name: string | null }): boolean {
  return cmd.path?.includes("/") === true || cmd.name?.endsWith(".sh") === true;
}

/** What the command's own lookups see: the line's `PATH`, then a prefix assignment. */
function effective(vars: Vars, assigned: readonly Assignment[]): Held {
  let entries: Held = held(vars);
  for (const assignment of assigned) if (isPathName(assignment)) entries = applied(assignment, entries);
  return entries;
}

/** A walk for the commands a shell or `find -exec` runs under this command, which inherit a prefix `PATH` through the environment. */
export function withPrefixPath<T extends { scope: { vars: Vars } }>(w: T, cmd: { assigned: readonly Assignment[] }): T {
  if (!cmd.assigned.some(isPathName)) return w;
  const vars = new Map(w.scope.vars);
  const entries = effective(vars, cmd.assigned);
  if (entries === undefined) vars.delete(SEARCH_KEY);
  else vars.set(SEARCH_KEY, entries === null ? null : entries.join(":"));
  return { ...w, scope: { ...w.scope, vars } };
}

/**
 * The `PATH` a command's bare name is looked up on: what the line stored before it, then a prefix assignment (`PATH=.:$PATH s`,
 * `env PATH=. s`), which holds for that command alone. Absent when the line never set `PATH`.
 */
export function searchPathOf(vars: Vars, cmd: { assigned: readonly Assignment[]; wrappers?: string[] }): { searchPath?: SearchPath } {
  const entries = effective(vars, cmd.assigned);
  if (entries === undefined) return {};
  const list = (entries ?? [UNKNOWN_ENTRY]).filter((entry) => entry !== SOFT_ENTRY).map((entry) => entry.replace(CWD_RE, "."));
  const guessed = (entries ?? []).includes(SOFT_ENTRY);
  const unknown = list.some((entry) => entry === UNKNOWN_ENTRY || (DYNAMIC_RE.test(entry) && !ABSOLUTE_RE.test(entry)) || (entry.startsWith("~") && !ABSOLUTE_RE.test(entry)));
  const named = list.filter((entry) => !ABSOLUTE_RE.test(entry) && !DYNAMIC_RE.test(entry) && !entry.startsWith("~"));
  const dirs = guessed && !named.includes(".") ? [...named, "."] : named;
  const soft = guessed && named.length === 0 ? { soft: true as const } : {};
  return { searchPath: { dirs, unknown, ...soft, ...(cmd.wrappers ? { wrappers: cmd.wrappers } : {}) } };
}
