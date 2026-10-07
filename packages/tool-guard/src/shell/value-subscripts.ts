import { tokenize } from "./lexer.js";
import type { Token } from "./lexer.js";
import type { Vars } from "./vars.js";

/** A value that names another value is followed this many times; past it the chain ends with no verdict. */
const MAX_HOPS = 16;
/** A name in an expression, bare or after a `$`, but not inside a number such as `0x1F` or `16#ff`. */
const NAME_RE = /(?<![\w#])[A-Za-z_]\w*/g;

/**
 * Bash evaluates the value of a name in arithmetic as an expression, and runs a `$( )` or backquote in it. Returns
 * the token lists of each such substitution in the values the expressions reach through known names, read with
 * the shell's own lexer; an unknown value, a cycle and a chain past the cap yield nothing more.
 */
export function valueSubstitutions(expressions: string[], vars: Vars): Token[][] {
  const found: Token[][] = [];
  const seen = new Set<string>();
  const pending = [...expressions];
  for (let text = pending.pop(); text !== undefined && seen.size <= MAX_HOPS; text = pending.pop()) {
    for (const [name] of text.matchAll(NAME_RE)) {
      const value = seen.has(name) ? null : vars.get(name);
      if (typeof value !== "string") continue;
      seen.add(name);
      found.push(...tokenize(value).flatMap(nested));
      pending.push(value);
    }
  }
  return found;
}

function nested(token: Token): Token[][] {
  if (token.type === "redirect") return [...(token.target?.subs ?? []), ...token.subs];
  return token.type === "op" ? [] : token.subs;
}

const SUBSCRIPT_WRITE_RE = /^[A-Za-z_]\w*\[(.*)\]\+?=/s;
const ELEMENT_READ_RE = /\$\{[!#]?[A-Za-z_]\w*\[/g;
const OFFSET_RE = /\$\{[A-Za-z_]\w*(?:\[[^\]]*\])?:(?![-=+?])([^}]*)\}/g;
const IDENTIFIER_RE = /^[A-Za-z_]\w*$/;
const DECLARER_RE = /^(?:declare|typeset|local)$/;

/**
 * The text of a command's words that bash evaluates as arithmetic apart from `(( ))`, `let` and `[[`: a `$[ ]`,
 * an array subscript written or read, a substring offset and length, and the names a `declare -i` makes integers.
 */
export function arithmeticWordTexts(values: string[]): string[] {
  return [...bracketBodies(values.join(" "), "$["), ...values.flatMap(wordSubscripts), ...integerNames(values)];
}

function wordSubscripts(value: string): string[] {
  const written = SUBSCRIPT_WRITE_RE.exec(value)?.[1] ?? [];
  const read = [...value.matchAll(ELEMENT_READ_RE)].flatMap((m) => bracketBodies(value.slice(m.index + m[0].length - 1), "["));
  return [written, ...read, ...[...value.matchAll(OFFSET_RE)].map((m) => m[1] as string)].flat();
}

/** The text between each `open` and its closing bracket. */
function bracketBodies(text: string, open: string): string[] {
  const bodies: string[] = [];
  for (let at = text.indexOf(open); at >= 0; at = text.indexOf(open, at + 1)) {
    bodies.push(text.slice(at + open.length, closing(text, at + open.length - 1, "[", "]")));
  }
  return bodies;
}

/** A `declare -i` evaluates the value a name already holds. */
function integerNames(values: string[]): string[] {
  const at = values.findIndex((v) => DECLARER_RE.test(v));
  const rest = at < 0 ? [] : values.slice(at + 1);
  return rest.some((v) => /^-[a-zA-Z]*i/.test(v)) ? rest.filter((v) => IDENTIFIER_RE.test(v)) : [];
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
