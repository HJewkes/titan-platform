import type { WordToken } from "./lexer.js";
import { printedText } from "./printed.js";

/** Shell variables assigned earlier in the same command string; null means assigned but not knowable. */
export type Vars = Map<string, string | null>;

/**
 * `NAME=value`, `NAME+=value` or `NAME[i]=value`. An `append` depends on the earlier value; an `element`
 * write keeps its value only as `NAME[0]=literal`, the element `$NAME` reads, and persists even before a command.
 */
export type Assignment = [name: string, value: string | null, kind?: "append" | "element"];

/** The subscript ends at the last `]` before `=`, so a nested subscript never hides that the word assigns. */
export const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[.*\])?\+?=/s;
const ASSIGNMENT_PARTS_RE = /^([A-Za-z_][A-Za-z0-9_]*)(\[.*\])?(\+?)=/s;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A target may carry a subscript: bash writes one element, so the whole variable is no longer what it was. */
const TARGET_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[.*\])?$/s;
/** A hidden slot's name is no shell identifier, so no command the user writes can assign or read it. */
const SLOT_ASSIGNMENT_RE = /^local@\d+=/;
const DECLARERS = new Set(["export", "declare", "typeset", "local", "readonly"]);
/** Bash rejects a subscripted name here as no valid identifier, so the variable keeps its value. */
const SCALAR_DECLARERS = new Set(["export", "readonly"]);
/** An `r` in an option cluster: whether an element write then lands differs across bash versions. */
const READONLY_FLAG_RE = /^-[A-Za-z]*r/;
const DECLARE_LETTERS = new Set("aAfFgiIlnrtuxp");
/** The option letters each builtin accepts; bash rejects any other and assigns nothing. */
const OPTION_LETTERS: Record<string, Set<string>> = {
  declare: DECLARE_LETTERS,
  typeset: DECLARE_LETTERS,
  local: DECLARE_LETTERS,
  export: new Set("fnp"),
  readonly: new Set("aAfp"),
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
  if (w.hidden && SLOT_ASSIGNMENT_RE.test(w.value)) {
    const eq = w.value.indexOf("=");
    return [w.value.slice(0, eq), w.dynamic ? null : w.value.slice(eq + 1)];
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
  if (kind !== "append") vars.set(name, value);
  else {
    const prior = vars.get(name) ?? null;
    vars.set(name, prior !== null && value !== null ? prior + value : null);
  }
}

/**
 * Applies the effect a command has on shell variables: declarations and `printf -v` set them, `read` and
 * friends make them unknowable, and so does an element write before it, which bash may keep once it ends.
 */
export function trackVars({ name, args, assigned }: TrackedCommand, vars: Vars): void {
  if (name === null) return;
  for (const [target, , kind] of assigned) if (kind === "element") vars.set(target, null);
  if (DECLARERS.has(name)) {
    const readonly = args.some((a) => READONLY_FLAG_RE.test(a.value));
    for (const arg of args) declareArg(name, parseAssignment(arg), readonly, vars);
    if (args.some((a) => unreadableDeclareWord(name, a))) forgetAll(vars);
    return;
  }
  if (name === "printf") printfVar(args, vars);
  for (const target of clobberedNames(name, args)) vars.set(target, null);
}

/** A word known only at run time may be any assignment; an option bash rejects may leave any assignment unmade. */
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

/** `export` and `readonly` reject an element name; a readonly element may or may not be written, so it is unknown. */
function declareArg(name: string, assignment: Assignment | null, readonly: boolean, vars: Vars): void {
  if (!assignment) return;
  if (assignment[2] !== "element") assign(vars, assignment);
  else if (!SCALAR_DECLARERS.has(name)) vars.set(assignment[0], readonly ? null : assignment[1]);
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
  vars.set(base[1] as string, subscripted ? null : printedText("printf", args.slice(attached ? 1 : 2)));
}
