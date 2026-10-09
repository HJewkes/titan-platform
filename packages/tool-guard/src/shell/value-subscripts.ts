import { ParseError, scanSubstitutions, tokenize } from "./lexer.js";
import type { Token } from "./lexer.js";
import type { Vars } from "./vars.js";

/** A value that names another value is followed this many times; past it the chain ends with no verdict. */
const MAX_HOPS = 16;
/** A name in an expression, bare or after a `$`, but not inside a number such as `0x1F` or `16#ff`. */
const NAME_RE = /(?<![\w#])[A-Za-z_]\w*/g;

/** What decides how a substitution in a value is walked: the working directory, the wrappers and the variables. */
interface ValueScope {
  vars: Vars;
  dir: string | null;
  wrapping: readonly string[];
}

/** What one classification has walked so far, keyed by the object that lives as long as it does. */
interface Walked {
  /** Each read, and whether its substitutions could be had in full. */
  reads: Map<string, boolean>;
  lists: number;
}
const walked = new WeakMap<object, Walked>();
/**
 * A line can change a variable the substitutions use between reads, so each read is a new walk. Past this many
 * substitutions walked in one classification the rest of the values are left as main reads them, which keeps
 * the cost of an 8 KiB line far below the hook's timeout.
 */
const MAX_LISTS = 1500;

/**
 * Bash evaluates the value of a name in arithmetic as an expression, and runs a `$( )` or backquote in it. Returns
 * the token lists of each such substitution in the values the expressions reach through known names, read with
 * the shell's own lexer; an unknown value, a cycle and a chain past the cap yield nothing more. A value read
 * again under the same scope in one classification (`run`) yields nothing the second time, so the cost stays
 * linear. When `sure` is set, expressions arithmetic surely evaluates: a value whose substitutions cannot all be
 * had, because the lexer rejects it or the budget is spent, throws a ParseError rather than yielding fewer.
 */
export function valueSubstitutions(expressions: string[], scope: ValueScope, run: object, sure: boolean): Token[][] {
  const state = walked.get(run) ?? { reads: new Map<string, boolean>(), lists: 0 };
  walked.set(run, state);
  const found: Token[][] = [];
  const seen = new Set<string>();
  const pending = [...expressions];
  for (let text = pending.pop(); text !== undefined && seen.size <= MAX_HOPS; text = pending.pop()) {
    for (const [name] of text.matchAll(NAME_RE)) {
      const value = seen.has(name) ? null : scope.vars.get(name);
      if (typeof value !== "string") continue;
      seen.add(name);
      const complete = read(state, scope, value, sure, found);
      if (sure && !complete) throw new ParseError("a value read as arithmetic holds substitutions that cannot be walked");
      pending.push(value);
    }
  }
  return found;
}

/** Adds the substitutions of a value this scope has not walked before; says whether the value was had in full. */
function read(state: Walked, scope: ValueScope, value: string, sure: boolean, found: Token[][]): boolean {
  const key = readKey(scope, value, sure);
  const before = state.reads.get(key);
  if (before !== undefined) return before;
  const { lists, complete } = substitutionsOf(value);
  const room = MAX_LISTS - state.lists;
  const added = lists.slice(0, room);
  found.push(...added);
  state.lists += added.length;
  state.reads.set(key, complete && added.length === lists.length);
  return state.reads.get(key) === true;
}

/** A walk that a sure read makes is told apart from a maybe read, whose failed walk is dropped and so proves nothing. */
function readKey(scope: ValueScope, value: string, sure: boolean): string {
  const names = [...value.matchAll(NAME_RE)].map(([n]) => scope.vars.get(n) ?? null);
  return JSON.stringify([value, scope.dir, scope.wrapping, names, sure]);
}

function substitutionsOf(value: string): { lists: Token[][]; complete: boolean } {
  try {
    return { lists: tokenize(value).flatMap(nested), complete: true };
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
  }
  try {
    return { lists: scanSubstitutions(value, 0, value.length), complete: true };
  } catch (error) {
    if (error instanceof ParseError) return { lists: [], complete: false };
    throw error;
  }
}

/** Runs one walk of a value's substitution, and drops it on a ParseError: a name arithmetic only maybe reads may add actions to the line, not refuse it. */
export function walkOrDrop(walk: () => void): void {
  try {
    walk();
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
  }
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
