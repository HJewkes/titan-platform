import type { WordToken } from "./lexer.js";
import { printedText } from "./printed.js";

/**
 * Shell variables assigned earlier in the same command string; null means assigned but not knowable.
 * Hidden `readonly@NAME` keys, which no identifier can spell, hold `""` when NAME is surely readonly and
 * null when it may be; `readonly@*` means any variable may be. Scopes copy them along with the values.
 */
export type Vars = Map<string, string | null>;

/**
 * `NAME=value`, `NAME+=value` or `NAME[i]=value`. An `append` depends on the earlier value; an `element`
 * write keeps its value only as `NAME[0]=literal`, the element `$NAME` reads, and persists even before a command.
 * A `hidden` write is the walk's own save or restore of a function local, which no readonly check stops.
 */
export type Assignment = [name: string, value: string | null, kind?: "append" | "element" | "hidden"];

/** The subscript ends at the last `]` before `=`, so a nested subscript never hides that the word assigns. */
export const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[.*\])?\+?=/s;
const ASSIGNMENT_PARTS_RE = /^([A-Za-z_][A-Za-z0-9_]*)(\[.*\])?(\+?)=/s;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A target may carry a subscript: bash writes one element, so the whole variable is no longer what it was. */
const TARGET_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[.*\])?$/s;
/** A name a declaration lists, with or without a subscript or a value. */
const DECLARED_RE = /^([A-Za-z_][A-Za-z0-9_]*)(\[.*\])?(?:\+?=|$)/s;
const ANY_READONLY = "readonly@*";
const DECLARERS = new Set(["export", "declare", "typeset", "local", "readonly"]);
/** Bash rejects a subscripted name here as no valid identifier, so the variable keeps its value. */
const SCALAR_DECLARERS = new Set(["export", "readonly"]);
/** An `r` in an option word, even one bash must still expand, may make every name the declaration lists readonly. */
const READONLY_FLAG_RE = /^-.*r/s;
/** Bash reads options only up to `--` or the first word that is none. */
const OPTION_WORD_RE = /^[-+]./s;
const DECLARE_LETTERS = new Set("airtx");
/**
 * The option letters that assign the value as written in bash 3.2 and 5 alike. Any other may assign nothing
 * (`-f` names a function, `-p` prints, bash 3.2 rejects `-g`, `-A`, `-n` and `-I`) or change the value (`-l`, `-u`).
 */
const OPTION_LETTERS: Record<string, Set<string>> = {
  declare: DECLARE_LETTERS,
  typeset: DECLARE_LETTERS,
  local: DECLARE_LETTERS,
  export: new Set("n"),
  readonly: new Set("a"),
};

export function lookup(vars: Vars, home: string | null, name: string): string | null {
  if (vars.has(name)) return vars.get(name) ?? null;
  return name === "HOME" ? home : null;
}

/** Replaces plain variable references with their literal values; any unknown reference leaves the word as it was. */
export function expandWord(w: WordToken, resolve: (name: string) => string | null): WordToken {
  if (!w.dynamic || w.computed || w.refs.length === 0) return w;
  let value = "";
  let last = 0;
  for (const ref of w.refs) {
    const literal = resolve(ref.name);
    if (literal === null) return w;
    value += w.value.slice(last, ref.start) + literal;
    last = ref.end;
  }
  return { ...w, value: value + w.value.slice(last), dynamic: false, refs: [], typed: w.typed ?? w.value };
}

/** `NAME=value` or `NAME+=value` split into its name and value, the value null when it is only known at run time. */
export function parseAssignment(w: WordToken): Assignment | null {
  if (w.hidden) {
    const eq = w.value.indexOf("=");
    return [w.value.slice(0, eq), w.dynamic ? null : w.value.slice(eq + 1), "hidden"];
  }
  const parts = ASSIGNMENT_PARTS_RE.exec(w.value);
  if (!parts) return null;
  const [whole, name = "", subscript, plus] = parts;
  const value = w.dynamic ? null : w.value.slice(whole.length);
  if (subscript !== undefined) return [name, subscript === "[0]" && !plus ? value : null, "element"];
  return plus ? [name, value, "append"] : [name, value];
}

/** Records an assignment; an append is literal only when both the earlier value and the appended part are. */
export function assign(vars: Vars, [name, value, kind]: Assignment): void {
  if (kind === "hidden") restore(vars, name, value);
  else if (kind !== "append") write(vars, name, value);
  else {
    const prior = vars.get(name) ?? null;
    write(vars, name, prior !== null && value !== null ? prior + value : null);
  }
}

/** A copy for a new shell: `eval` keeps every readonly variable and a child shell drops them, so each only may be. */
export function childVars(vars: Vars): Vars {
  const copy = new Map(vars);
  for (const key of copy.keys()) if (key.startsWith("readonly@")) copy.set(key, null);
  return copy;
}

const readonlyKey = (name: string) => `readonly@${name}`;

/** Bash rejects a write to a readonly variable, so it keeps its value; one that may be readonly becomes unknown. */
function write(vars: Vars, name: string, value: string | null): void {
  const flag = vars.get(readonlyKey(name));
  if (flag === "") return;
  vars.set(name, flag === null || vars.has(ANY_READONLY) ? null : value);
}

/** A function's return restores a local's outer value, which may or may not have been readonly. */
function restore(vars: Vars, name: string, value: string | null): void {
  vars.set(name, value);
  if (vars.has(readonlyKey(name))) vars.set(readonlyKey(name), null);
}

/**
 * Applies the effect a command has on shell variables: declarations and `printf -v` set them, `read` and
 * friends make them unknowable, and so does an element write before it, which bash may keep once it ends.
 */
export function trackVars({ name, args, assigned }: TrackedCommand, vars: Vars): void {
  if (name === null) return;
  for (const [target, , kind] of assigned) if (kind === "element") write(vars, target, null);
  if (DECLARERS.has(name)) return trackDeclaration(name, args, vars);
  if (name === "printf") printfVar(args, vars);
  for (const target of clobberedNames(name, args)) write(vars, target, null);
}

/**
 * Each write lands first and the names become readonly after it. A word known only at run time may be
 * `-r` and any name, so from then on any variable may be readonly.
 */
function trackDeclaration(name: string, args: WordToken[], vars: Vars): void {
  const end = args.findIndex((a) => a.dynamic || a.value === "--" || !OPTION_WORD_RE.test(a.value));
  const options = end < 0 ? args : args.slice(0, end);
  const readonly = name === "readonly" || (name !== "export" && options.some((a) => READONLY_FLAG_RE.test(a.value)));
  const mode: ReadonlyMode = !readonly ? null : options.some((a) => a.value.includes("a")) ? "array" : "scalar";
  for (const arg of args) declareArg(name, parseAssignment(arg), mode, vars);
  if (readonly) for (const arg of args) markReadonly(name, arg, vars);
  if (args.some((a) => unreadableDeclareWord(name, a))) forgetAll(vars);
  if (args.some((a) => a.dynamic && parseAssignment(a) === null)) vars.set(ANY_READONLY, null);
}

/** A word known only at run time may be any assignment; an option outside the stable set may leave any unmade or changed. */
function unreadableDeclareWord(name: string, arg: WordToken): boolean {
  if (arg.dynamic) return parseAssignment(arg) === null;
  const v = arg.value;
  if (v === "--" || !(v.startsWith("-") || v.startsWith("+"))) return false;
  const letters = [...v.slice(1)];
  return letters.length === 0 || letters.some((c) => !OPTION_LETTERS[name]?.has(c));
}

/** Nulls every tracked variable, `HOME` included, after a declaration this walk cannot read. */
function forgetAll(vars: Vars): void {
  for (const key of vars.keys()) vars.set(key, null);
  vars.set("HOME", null);
}

/** How a declaration makes its names readonly; null when it does not. */
type ReadonlyMode = "scalar" | "array" | null;

/**
 * `export` and `readonly` reject an element name. Whether a readonly element write lands differs across bash
 * versions, and so does a readonly array assignment, which bash 3.2 rejects; either leaves the value unknown.
 */
function declareArg(name: string, assignment: Assignment | null, mode: ReadonlyMode, vars: Vars): void {
  if (!assignment) return;
  const [target, value, kind] = assignment;
  if (kind === "element") {
    if (!SCALAR_DECLARERS.has(name)) write(vars, target, mode ? null : value);
  } else if (mode === "array") write(vars, target, null);
  else assign(vars, assignment);
}

/** Marks the variable a declaration word names, plain or with a subscript `readonly` rejects. */
function markReadonly(name: string, arg: WordToken, vars: Vars): void {
  const [, variable, subscript] = DECLARED_RE.exec(arg.value) ?? [];
  if (variable && !(subscript !== undefined && SCALAR_DECLARERS.has(name))) vars.set(readonlyKey(variable), "");
}

interface TrackedCommand {
  name: string | null;
  args: WordToken[];
  assigned: Assignment[];
}

/** Only a shell identifier is written: bash rejects any other target, so a hidden slot stays out of reach. */
function clobberedNames(name: string, args: WordToken[]): string[] {
  const values = args.map((a) => a.value);
  if (name === "read" || name === "unset") return values.flatMap((v) => TARGET_RE.exec(v)?.[1] ?? []);
  if (name === "for" && values[0] !== undefined && IDENTIFIER_RE.test(values[0])) return [values[0]];
  if (name === "mapfile" || name === "readarray") return ["MAPFILE", ...values.filter((v) => IDENTIFIER_RE.test(v))];
  return [];
}

/** `printf -v NAME` or `printf -vNAME` stores the text it would print; only a first word is an option, so `printf -- -vX` sets nothing. */
function printfVar(args: WordToken[], vars: Vars): void {
  const first = args[0]?.value;
  if (first === undefined || !first.startsWith("-v")) return;
  const attached = first.slice(2);
  const target = attached || args[1]?.value;
  const base = target === undefined ? undefined : TARGET_RE.exec(target);
  if (!base) return;
  const subscripted = base[0] !== base[1];
  write(vars, base[1] as string, subscripted ? null : printedText("printf", args.slice(attached ? 1 : 2)));
}
