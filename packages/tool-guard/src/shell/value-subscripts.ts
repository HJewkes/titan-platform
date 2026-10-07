import type { Vars } from "./vars.js";

/** A value that names another value is followed this many times; past it the chain ends with no verdict. */
const MAX_HOPS = 16;
const NAME_RE = /(?<![\w$#])[A-Za-z_]\w*/g;

/**
 * Bash evaluates the value of a name in arithmetic as an expression, and runs a `$( )` or backquote inside an
 * array subscript of that value. Returns the text of each such substitution in the values the expressions reach
 * through known names; an unknown value, a cycle and a chain past the cap yield nothing more.
 */
export function valueSubstitutions(expressions: string[], vars: Vars): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const pending = [...expressions];
  for (let text = pending.pop(); text !== undefined && seen.size <= MAX_HOPS; text = pending.pop()) {
    for (const [name] of text.matchAll(NAME_RE)) {
      const value = seen.has(name) ? null : vars.get(name);
      if (typeof value !== "string") continue;
      seen.add(name);
      found.push(...subscripts(value).flatMap(substitutions));
      pending.push(value);
    }
  }
  return found;
}

/** The text between each outermost `[` and its `]`. */
function subscripts(value: string): string[] {
  const spans: string[] = [];
  for (let at = value.indexOf("["); at >= 0; ) {
    const end = closing(value, at, "[", "]");
    spans.push(value.slice(at + 1, end));
    at = value.indexOf("[", end);
  }
  return spans;
}

/** The body of each `$( )` and backquote pair in a subscript. */
function substitutions(subscript: string): string[] {
  const bodies: string[] = [];
  for (let at = subscript.indexOf("$("); at >= 0; ) {
    const end = closing(subscript, at + 1, "(", ")");
    bodies.push(subscript.slice(at + 2, end));
    at = subscript.indexOf("$(", end);
  }
  for (const m of subscript.matchAll(/`([^`]*)`/g)) bodies.push(m[1] as string);
  return bodies;
}

/** The index of the bracket closing the one at `from`, or the end of the text. */
function closing(text: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === open) depth++;
    if (text[i] === close && --depth === 0) return i;
  }
  return text.length;
}
