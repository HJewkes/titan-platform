import type { WordToken } from "./lexer.js";

/** Shell variables assigned earlier in the same command string; null means assigned but not knowable. */
export type Vars = Map<string, string | null>;

export const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
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
  return { ...w, value: value + w.value.slice(last), dynamic: false, refs: [] };
}

/** `NAME=value` split into its name and value, the value null when it is only known at run time. */
export function parseAssignment(w: WordToken): [string, string | null] | null {
  if (!ASSIGNMENT_RE.test(w.value)) return null;
  const eq = w.value.indexOf("=");
  return [w.value.slice(0, eq), w.dynamic ? null : w.value.slice(eq + 1)];
}

/** Applies the effect a builtin has on shell variables: declarations set them, `read` and friends make them unknowable. */
export function trackVars(name: string, args: WordToken[], vars: Vars): void {
  if (DECLARERS.has(name)) {
    for (const arg of args) {
      const assignment = parseAssignment(arg);
      if (assignment) vars.set(...assignment);
    }
    return;
  }
  for (const target of clobberedNames(name, args)) vars.set(target, null);
}

function clobberedNames(name: string, args: WordToken[]): string[] {
  const values = args.map((a) => a.value);
  if (name === "read" || name === "unset") return values.filter((v) => !v.startsWith("-"));
  if (name === "printf") {
    const at = values.indexOf("-v");
    return at >= 0 && values[at + 1] !== undefined ? [values[at + 1] as string] : [];
  }
  if (name === "for" && values[0] !== undefined) return [values[0]];
  return [];
}
