import type { RedirectToken, WordToken } from "./lexer.js";
import { NAMED_FD_RE, tokenize } from "./lexer.js";
import { shellSetsName } from "./ifs-arith.js";
import type { MathPlace } from "./math-places.js";
import { readPieces } from "./math-pieces.js";
import { VALUE_SEPARATOR, writtenText } from "./line-writes.js";
import { ANY_WRITE, ENVIRONMENT_UNKNOWN, NOT_PATH_LINE, POSITIONALS_SET } from "./math-trust.js";
import { isNumeric } from "./numeric-names.js";
import { numericOutput } from "./numeric-output.js";

/** What a shell reads as a store in math: an assignment operator (zsh adds `&&=`, `||=`, `^^=`) or an increment. */
const STORE_OPERATOR = String.raw`(?:\*\*|<<|>>|&&|\|\||\^\^|[-+*/%&^|])?=(?!=)|\+\+|--`;
/** A bare name in math is read as the math its value holds; one after a `16#` base is a digit. */
const MATH_NAME_RE = /(?<![\w$#])[A-Za-z_]\w*/g;
/** Counters the shell keeps, numbers unless the line writes them. */
const SHELL_COUNTERS = new Set(["SECONDS", "RANDOM", "SRANDOM", "EPOCHSECONDS", "EPOCHREALTIME", "LINENO", "PPID", "UID", "EUID", "BASHPID"]);
const POSITIONAL_RE = /^(?:\d+|[@*])$/;

/** The text a name holds as math reads it: a string when the line wrote it, null when unknown, undefined when trusted. */
type Resolve = (name: string) => string | null | undefined;

/** How math in one scope reads names, and whether a command substitution's output may be read as digits there. */
interface MathScope {
  resolve: Resolve;
  pathLine: boolean;
}

/** Reads names through the line's writes (`math-trust.ts`); a scope with none of its marks trusts every name. */
export const scopeNames = (vars: ReadonlyMap<string, string | null>): MathScope => ({
  resolve: (name) => resolveName(vars, name),
  pathLine: !vars.has(NOT_PATH_LINE),
});

/**
 * Every write the line makes to a name, wherever it sits, is what math may read there. A name it never writes holds
 * the Bash tool's environment, which the line cannot set and so is trusted, as are the positional parameters, which
 * the harness passes none of; a script's text trusts neither. A name the shell sets itself (`_`, `REPLY`, `MATCH`)
 * holds text the line never wrote, so it reads as unknown unless the line wrote a number there.
 */
function resolveName(vars: ReadonlyMap<string, string | null>, name: string): string | null | undefined {
  if (vars.has(ANY_WRITE)) return null;
  if (shellSetsName(name)) return vars.has(name) && isNumeric(vars, name) ? undefined : null;
  // zsh's `argv` is the positional parameters, so a builtin that writes it (`read -A argv`) sets them.
  if (POSITIONAL_RE.test(name)) return vars.has(POSITIONALS_SET) || vars.has(ENVIRONMENT_UNKNOWN) || writtenText(vars, "argv") !== undefined ? null : undefined;
  const written = writtenText(vars, name);
  if (written !== undefined) return written;
  return vars.has(ENVIRONMENT_UNKNOWN) && !SHELL_COUNTERS.has(name) ? null : undefined;
}

/** Past this length a math text is not read: the reader scans each subscript, so a long run of openers would cost quadratic time. */
const MAX_MATH_TEXT = 1024;

/**
 * A reader of arithmetic that stores into any of `names`: `commands[y]=0`, `x+=1`, `BASH_CMDS[y]++`, `--functions`.
 * One list serves every caller; TP-3295 passes the exec-hook parameters through the same readers.
 */
export function storeReader(names: ReadonlySet<string>): RegExp {
  const name = `(?<![A-Za-z0-9_])(?:${[...names].join("|")})(?![A-Za-z0-9_])`;
  return new RegExp(`${name}\\s*(?:\\[.*?\\])?\\s*(?:${STORE_OPERATOR})|(?:\\+\\+|--)\\s*${name}`, "s");
}

/**
 * Whether the math text may store into a name. The shell expands each run-time piece before it parses the math, so
 * the text is safe only when each piece can yield nothing but a number or trusted text: a literal store, a piece no
 * rule reads (`${!x}`, `${x/a/b}`, `$'…'`), a substitution whose output is not known digits (`$(cat f)`), or a name
 * whose text may store (`e='commands[y]=0'; (( $e ))`, `X=$(cat f); (( X ))`) counts.
 */
function mathStores(text: string, reader: RegExp, scope: MathScope, seen: Set<string>): boolean {
  if (text.length > MAX_MATH_TEXT || reader.test(text)) return true;
  const pieces = readPieces(text);
  if (pieces.opaque || reader.test(pieces.joined)) return true;
  if (pieces.commands.some((command) => !scope.pathLine || !printsDigits(command))) return true;
  if (pieces.texts.some((inner) => mathStores(inner, reader, scope, seen))) return true;
  if (pieces.names.some((name) => nameStores(name, true, reader, scope, seen))) return true;
  return [...pieces.bare.matchAll(MATH_NAME_RE)].some(([name]) => nameStores(name, false, reader, scope, seen));
}

/**
 * Whether a name's text may store. A bare name's value is math of its own; a `$name` is spliced into the text around
 * it, where `commands$x` with `x='[y]=0'` stores, so its value must also be inert: digits once its own pieces are read.
 * Each name is read once a way, so a chain of names that point at each other costs no more than its length.
 */
function nameStores(name: string, spliced: boolean, reader: RegExp, scope: MathScope, seen: Set<string>): boolean {
  const key = spliced ? `$${name}` : name;
  if (seen.has(key)) return false;
  seen.add(key);
  const value = scope.resolve(name);
  if (value === undefined) return false;
  if (value === null) return true;
  return value.split(VALUE_SEPARATOR).some((each) => (spliced && !inert(each)) || mathStores(each, reader, scope, seen));
}

const inert = (value: string) => {
  const pieces = readPieces(value);
  return !pieces.opaque && /^[\d\s.]*$/.test(pieces.joined);
};

/** Whether a text the shell evaluates whole as math may store. */
export function textStores(text: string, reader: RegExp, scope: MathScope): boolean {
  return mathStores(text, reader, scope, new Set());
}

/** A substitution's text the lexer cannot read prints anything. */
function printsDigits(command: string): boolean {
  try {
    return numericOutput(tokenize(command));
  } catch {
    return false;
  }
}

/** Whether any word is wholly math, as every operand of `let`, `shift` or an `(( ))` body is. */
export function operandsStore(words: WordToken[], reader: RegExp, scope: MathScope): boolean {
  return words.some((word) => textStores(word.value, reader, scope));
}

/** Whether any place a shell evaluates inside words and redirects as math (`mathPlaces`) may store. */
export function placesStore(places: MathPlace[], reader: RegExp, scope: MathScope): boolean {
  return places.some((place) => textStores(place.text, reader, scope));
}

/** Whether a redirect stores its descriptor number into one of `names` (`exec {BASH_CMDS[y]}>f`); a subscript is a math place. */
export function fdVariableStores(redirects: RedirectToken[], names: ReadonlySet<string>): boolean {
  return redirects.some((r) => names.has(NAMED_FD_RE.exec(r.named ?? r.fd ?? "")?.[1] ?? ""));
}
