import type { RedirectToken } from "./lexer.js";
import { NAMED_FD_RE } from "./lexer.js";
import { ARITHMETIC_OPENER_RE } from "./math-places.js";
import type { MathPlace } from "./math-places.js";
import { isNumeric } from "./numeric-names.js";

/** What a shell reads as a store in math: an assignment operator (zsh adds `&&=`, `||=`, `^^=`) or an increment. */
const STORE_OPERATOR = String.raw`(?:\*\*|<<|>>|&&|\|\||\^\^|[-+*/%&^|])?=(?!=)|\+\+|--`;
/** Expansions that yield a number or a flag a script cannot shape: `$#`, `$?`, `$$`, `$!`, `${#x}`, zsh `$+x`. */
const NUMERIC_EXPANSION_RE = /\$[#?$!]|\$\{#(?:[A-Za-z_]\w*(?:\[[^\]$`]*\])?)?\}|\$\+[A-Za-z_]\w*(?:\[[^\]$`]*\])?/g;
/** A bare name in math is read as the math its value holds. */
const MATH_NAME_RE = /(?<![A-Za-z0-9_$])[A-Za-z_]\w*/g;

/** The value the line gave a name: a string when known, null when the line set it to something it cannot read, undefined when the line never set it. */
type Resolve = (name: string) => string | null | undefined;

/** Resolves names through the walk's variables, which hold null for a value only known at run time; a name arithmetic wrote holds a number, so it reads as never set. */
export const scopeNames = (vars: ReadonlyMap<string, string | null>): Resolve => (name) => {
  if (!vars.has(name) || isNumeric(vars, name)) return undefined;
  return vars.get(name) ?? null;
};

/** Past this length a math text is not read: the reader scans each subscript, so a long run of openers would cost quadratic time. */
const MAX_MATH_TEXT = 1024;

/**
 * A reader of arithmetic that stores into any of `names`: `commands[y]=0`, `x+=1`, `BASH_CMDS[y]++`, `--functions`.
 * One list serves every caller; TP-3295 passes the exec-hook parameters through the same readers.
 */
export function storeReader(names: ReadonlySet<string>): RegExp {
  const name = `(?<![A-Za-z0-9_])(?:${[...names].join("|")})(?![A-Za-z0-9_])`;
  return new RegExp(`${name}(?:\\[.*?\\])?\\s*(?:${STORE_OPERATOR})|(?:\\+\\+|--)\\s*${name}`, "s");
}

/**
 * Whether the math text may store into a name: a literal store, a run-time expansion that may hold one
 * (`e='commands[y]=0'; (( $e ))`), or a bare name the line set to a store or to a value it cannot read (`X=$(cat f); (( X ))`),
 * since math reads a bare name as the math its value holds. A dynamic text counts unless every expansion in it yields a number.
 */
function mathStores(text: string, dynamic: boolean, reader: RegExp, resolve: Resolve): boolean {
  if (text.length > MAX_MATH_TEXT || reader.test(text)) return true;
  if (dynamic && /[$`]/.test(text.replace(NUMERIC_EXPANSION_RE, "").replace(ARITHMETIC_OPENER_RE, ""))) return true;
  return namesStore(text, reader, resolve, new Set());
}

/** Each name is read once, so a chain of names that point at each other costs no more than its length. */
function namesStore(text: string, reader: RegExp, resolve: Resolve, seen: Set<string>): boolean {
  for (const [name] of text.matchAll(MATH_NAME_RE)) {
    if (seen.has(name)) continue;
    seen.add(name);
    const value = resolve(name);
    if (value === undefined) continue;
    if (value === null || value.length > MAX_MATH_TEXT || reader.test(value) || namesStore(value, reader, resolve, seen)) return true;
  }
  return false;
}

/** Whether any word is wholly math, as every operand of `let`, `shift` or an `(( ))` body is. */
export function operandsStore(words: Array<{ value: string; dynamic: boolean }>, reader: RegExp, resolve: Resolve): boolean {
  return words.some((word) => mathStores(word.value, word.dynamic, reader, resolve));
}

/** Whether any place a shell evaluates inside words and redirects as math (`mathPlaces`) may store. */
export function placesStore(places: MathPlace[], reader: RegExp, resolve: Resolve): boolean {
  return places.some((place) => mathStores(place.text, place.dynamic, reader, resolve));
}

/** Whether a redirect stores its descriptor number into one of `names` (`exec {BASH_CMDS[y]}>f`); a subscript is a math place. */
export function fdVariableStores(redirects: RedirectToken[], names: ReadonlySet<string>): boolean {
  return redirects.some((r) => names.has(NAMED_FD_RE.exec(r.named ?? r.fd ?? "")?.[1] ?? ""));
}
