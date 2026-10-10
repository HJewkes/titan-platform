import { ParseError, scanSubstitutions, tokenize } from "./lexer.js";
import type { RedirectToken, Token } from "./lexer.js";
import { ValueWalkError } from "./unsure-readings.js";

/** A bracket before a substitution: code that runs only when the text is evaluated as a subscript. */
const SUBSCRIPT_CODE_RE = /\[[\s\S]*(?:\$\((?!\()|`)/;
/** A `$(( ))` is arithmetic, which runs nothing itself. */
const CODE_RE = /\$\((?!\()|`/;
/**
 * Past this many substitutions in the values one line stores, the rest cannot be walked, which keeps the cost of an
 * 8 KiB line far below the hook's timeout.
 */
const MAX_LISTS = 1500;

/**
 * What one line stores in its variables, and whether it evaluates arithmetic anywhere. Bash runs a substitution
 * inside a bracket of a stored value wherever arithmetic reaches that value, through more ways than any list of
 * read sites names, so the line is judged as a whole: each value is recorded where it is stored, and nothing is
 * walked or refused unless the line also evaluates arithmetic. Shared by every walk of one line.
 */
export interface ValueMarks {
  arithmetic: boolean;
  /** The line stores text the walk cannot know: input, an argument, a loop item, a value built at run time. */
  opaque: boolean;
  /** The text the line types holds a substitution after a bracket, in one word or split across several. */
  typed: boolean;
  bracket: boolean;
  /** A known value with code behind a bracket cannot be walked in full. */
  unwalkable: boolean;
  /** One walk per substitution in each known value with code behind a bracket. */
  walks: Array<() => void>;
  lists: number;
}

export function newMarks(): ValueMarks {
  return { arithmetic: false, opaque: false, typed: false, bracket: false, unwalkable: false, walks: [], lists: 0 };
}

/**
 * The one recorder for every value a variable takes: an assignment, a declaration, `printf -v`, a prefix to a
 * command, an array element, and, as unknown (null), whatever `read`, `mapfile`, a loop, positional parameters or
 * run-time text store. A known value with code behind a bracket keeps a walk of each substitution, which `walkLater`
 * makes in the scope the value was stored in.
 */
export function recordValue(marks: ValueMarks, value: string | null, walkLater: (list: Token[]) => () => void): void {
  if (value === null) {
    marks.opaque = true;
    return;
  }
  if (!SUBSCRIPT_CODE_RE.test(value) || marks.unwalkable) return;
  const lists = substitutionsOf(value);
  marks.lists += lists?.length ?? 0;
  if (lists === null || marks.lists > MAX_LISTS) marks.unwalkable = true;
  else marks.walks.push(...lists.map(walkLater));
}

/** Notes typed text, which may reach a variable the walk cannot follow; a bracket in one text and code in a later one count. */
export function noteTyped(marks: ValueMarks, text: string): void {
  if (marks.typed) return;
  const code = text.search(CODE_RE);
  const bracket = text.indexOf("[");
  marks.typed = code >= 0 && (marks.bracket || (bracket >= 0 && bracket < code));
  marks.bracket ||= bracket >= 0;
}

/** A heredoc body or here-string is text a `read` or `mapfile` may store; an unquoted body expands its own `$(( ))`. */
export function noteRedirect(marks: ValueMarks, redirect: RedirectToken): void {
  noteTyped(marks, redirect.body ?? redirect.target?.value ?? "");
  const literal = redirect.target?.quoted === true || redirect.target?.spliced === true;
  if (redirect.body !== null && !literal) marks.arithmetic ||= /\$\(\(|\$\[/.test(redirect.body);
}

/**
 * Ends a line: when it evaluates arithmetic, walks the substitutions of every known stored value, and refuses it
 * when a value cannot be walked or when it types code behind a bracket that it may store where the walk cannot see.
 */
export function settle(marks: ValueMarks): void {
  if (!marks.arithmetic) return;
  for (let next = marks.walks.shift(); next !== undefined; next = marks.walks.shift()) next();
  if (marks.unwalkable || (marks.opaque && marks.typed)) throw new ValueWalkError();
}

/** The token lists of each substitution in a value, read with the shell's own lexer; null when they cannot all be had. */
function substitutionsOf(value: string): Token[][] | null {
  try {
    return tokenize(value).flatMap(nested);
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
  }
  try {
    return scanSubstitutions(value, 0, value.length);
  } catch (error) {
    if (error instanceof ParseError) return null;
    throw error;
  }
}

function nested(token: Token): Token[][] {
  if (token.type === "redirect") return [...(token.target?.subs ?? []), ...token.subs];
  return token.type === "op" ? [] : token.subs;
}
