import { mayWriteRunTimeName } from "./ifs-writes.js";
import { tokenize } from "./lexer.js";
import type { Token, WordToken } from "./tokens.js";
import { ASSIGNMENT_RE, type Vars } from "./vars.js";

const DEFAULT_IFS = " \t\n";
/** A range whose ends are not both numbers may cover I, F or S. */
const LETTER_RANGE_RE = /(?:^|[^0-9-])\.\.|\.\.(?:[^0-9-]|$)/;
/** Quoting a word's value may still hold, so an `eval` or `sh -c` text re-lexes to IFS. */
const REQUOTED_RE = /[\\'"$]/;
/** Text that may build a name at run time: an expansion, a backquote or a glob. */
const RUN_TIME_TEXT_RE = /[$`?*[]/;
/** The walk's own nesting limit (`MAX_DEPTH` in commands.ts); past it the value counts as naming IFS. */
const RELEX_DEPTH = 8;

/**
 * Whether the text may write IFS: a word spells IFS once quotes, escapes, line continuations and `$'…'` are
 * removed and braces expanded (`declare I\FS=,`, `read {I,}FS`), or a write slot's name is built at run time
 * (`declare $a$b$c=,`, `read ?FS`). Where this model of bash runs out, it answers true.
 */
export function namesIfs(text: string, depth = 0): boolean {
  if (text.includes("IFS")) return true;
  if (!maySpellIfs(text) && !RUN_TIME_TEXT_RE.test(text)) return false;
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch {
    return true;
  }
  return tokenLists(tokens).some((list) => mayWriteRunTimeName(list) || wordValues(list).some((v) => valueNamesIfs(v, text, depth)));
}

/** A value equal to the text it came from re-lexes to itself, so only a shorter one is read again. */
function valueNamesIfs(value: string, text: string, depth: number): boolean {
  if (value.includes("IFS") || braceMaySpellIfs(value)) return true;
  if (!REQUOTED_RE.test(value) || value.length >= text.length) return false;
  return depth + 1 >= RELEX_DEPTH || namesIfs(value, depth + 1);
}

/**
 * Brace expansion keeps each word's characters in order, so without a letter range a word can spell IFS only
 * if it already holds I, F and S in order. This reads the quote-removed value, where a quoted brace or comma
 * looks unquoted, so it errs toward true rather than parse which braces bash expands.
 */
function braceMaySpellIfs(value: string): boolean {
  if (!value.includes("{")) return false;
  return holdsIfsInOrder(value) || LETTER_RANGE_RE.test(value);
}

/**
 * Quote removal, escapes, line continuations and brace lists only drop characters, so a text that becomes IFS
 * holds I, F and S in order, or a `$'…'` that decodes one, or a `..` range that makes one.
 */
function maySpellIfs(text: string): boolean {
  return holdsIfsInOrder(text) || text.includes("$'") || text.includes("..");
}

/** A linear scan; a regex like `I.*F.*S` backtracks cubically on a long text with no S. */
function holdsIfsInOrder(text: string): boolean {
  const i = text.indexOf("I");
  const f = i < 0 ? -1 : text.indexOf("F", i + 1);
  return f >= 0 && text.includes("S", f + 1);
}

/** The tokens and every token list nested in their command and process substitutions. */
function tokenLists(tokens: readonly Token[]): Token[][] {
  const nested = tokens.flatMap((t): Token[][] => {
    if (t.type === "word" || t.type === "subs") return t.subs;
    if (t.type === "redirect") return [...t.subs, ...(t.target?.subs ?? [])];
    return [];
  });
  return [[...tokens], ...nested.flatMap(tokenLists)];
}

/** Word values, redirect targets and heredoc bodies of one token list. */
function wordValues(tokens: readonly Token[]): string[] {
  return tokens.flatMap((t): string[] => {
    if (t.type === "word") return [t.value];
    if (t.type === "redirect") return [...(t.target ? [t.target.value] : []), ...(t.body === null ? [] : [t.body])];
    return [];
  });
}

/** A null IFS is a write the walk could not read, which may have set any separator. */
export function ifsChanged(vars: Vars): boolean {
  return vars.has("IFS") && vars.get("IFS") !== DEFAULT_IFS;
}

/**
 * Indexes of the words bash field-splits on IFS: unquoted plain-variable expansions past the leading
 * `NAME=value` run, which bash assigns without splitting. Computed words already read as run time.
 */
export function splittingWords(words: readonly WordToken[]): Set<number> {
  const found = new Set<number>();
  let leading = true;
  for (const [i, w] of words.entries()) {
    if (leading && ASSIGNMENT_RE.test(w.value)) continue;
    leading = false;
    if (w.dynamic && !w.computed && w.refs.length > 0 && w.unquotedExpansion) found.add(i);
  }
  return found;
}
