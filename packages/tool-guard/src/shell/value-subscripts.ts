import { ParseError, scanSubstitutions, tokenize } from "./lexer.js";
import type { Token } from "./lexer.js";
import { ValueWalkError } from "./unsure-readings.js";
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
 * the shell's own lexer; an unknown value, a cycle and a chain of values that lead on past the cap yields nothing more, or throws when the read is sure. A value read
 * again under the same scope in one classification (`run`) yields nothing the second time, so the cost stays
 * linear. When `sure` is set, expressions arithmetic surely evaluates: a value whose substitutions cannot all be
 * had, because the lexer rejects it or the budget is spent, throws a ValueWalkError rather than yielding fewer.
 */
export function valueSubstitutions(expressions: string[], scope: ValueScope, run: object, sure: boolean): Token[][] {
  const state = walked.get(run) ?? { reads: new Map<string, boolean>(), lists: 0 };
  walked.set(run, state);
  const found: Token[][] = [];
  const seen = new Set<string>();
  const pending = [...expressions];
  for (let text = pending.pop(); text !== undefined; text = pending.pop()) {
    for (const [name] of text.matchAll(NAME_RE)) {
      const value = seen.has(name) ? null : scope.vars.get(name);
      if (typeof value !== "string" || !leadsFurther(value, scope)) continue;
      if (seen.size >= MAX_HOPS && sure) throw new ValueWalkError();
      if (seen.size >= MAX_HOPS) continue;
      seen.add(name);
      if (!read(state, scope, value, sure, found) && sure) throw new ValueWalkError();
      pending.push(value);
    }
  }
  return found;
}

/** Whether a value can run something or name another value; a plain number cannot, so it costs no hop. */
function leadsFurther(value: string, scope: ValueScope): boolean {
  if (/[$`]/.test(value)) return true;
  return [...value.matchAll(NAME_RE)].some(([name]) => typeof scope.vars.get(name) === "string");
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
