import type { WordToken } from "./lexer.js";
import { printedText } from "./printed.js";

/** Shell variables assigned earlier in the same command string; null means assigned but not knowable. */
export type Vars = Map<string, string | null>;

/** `NAME=value` or `NAME+=value`; `append` marks the second, whose result depends on the earlier value. */
export type Assignment = [name: string, value: string | null, append?: true];

export const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A target may carry a subscript: bash writes one element, so the whole variable is no longer what it was. */
const TARGET_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[.*\])?$/s;
/** A hidden slot's name is no shell identifier, so no command the user writes can assign or read it. */
const SLOT_ASSIGNMENT_RE = /^local@\d+=/;
const DECLARERS = new Set(["export", "declare", "typeset", "local", "readonly"]);

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
  if (!ASSIGNMENT_RE.test(w.value) && !(w.hidden && SLOT_ASSIGNMENT_RE.test(w.value))) return null;
  const eq = w.value.indexOf("=");
  const value = w.dynamic ? null : w.value.slice(eq + 1);
  if (w.value[eq - 1] === "+") return [w.value.slice(0, eq - 1), value, true];
  return [w.value.slice(0, eq), value];
}

/** Records an assignment; an append is literal only when both the earlier value and the appended part are. */
export function assign(vars: Vars, [name, value, append]: Assignment): void {
  if (!append) vars.set(name, value);
  else {
    const prior = vars.get(name) ?? null;
    vars.set(name, prior !== null && value !== null ? prior + value : null);
  }
}

/** Applies the effect a builtin has on shell variables: declarations and `printf -v` set them, `read` and friends make them unknowable. */
export function trackVars(name: string, args: WordToken[], vars: Vars): void {
  if (DECLARERS.has(name)) {
    for (const arg of args) {
      const assignment = parseAssignment(arg);
      if (assignment) assign(vars, assignment);
    }
    return;
  }
  if (name === "printf") printfVar(args, vars);
  for (const target of clobberedNames(name, args)) vars.set(target, null);
}

/** Only a shell identifier is written: bash rejects any other target, so a hidden slot stays out of reach. */
function clobberedNames(name: string, args: WordToken[]): string[] {
  const values = args.map((a) => a.value);
  if (name === "read" || name === "unset") return values.flatMap((v) => TARGET_RE.exec(v)?.[1] ?? []);
  if (name === "for" && values[0] !== undefined && IDENTIFIER_RE.test(values[0])) return [values[0]];
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
