import { tokenize } from "./lexer.js";
import type { Token, WordToken } from "./tokens.js";
import { ASSIGNMENT_RE, type Vars } from "./vars.js";

const DEFAULT_IFS = " \t\n";
/** A range whose ends are not both numbers may cover I, F or S. */
const LETTER_RANGE_RE = /(?:^|[^0-9-])\.\.|\.\.(?:[^0-9-]|$)/;
/** Quoting a word's value may still hold, so an `eval` or `sh -c` text re-lexes to IFS. */
const REQUOTED_RE = /[\\'"$]/;
/** The walk's own nesting limit (`MAX_DEPTH` in commands.ts); past it the value counts as naming IFS. */
const RELEX_DEPTH = 8;

/**
 * Whether any word of the text may spell IFS once quotes, escapes, line continuations and `$'…'` are removed
 * and braces expanded, so `declare I\FS=,` or `read {I,}FS` counts as a write the walk may reach late.
 * Where this model of bash runs out, it answers true.
 */
export function namesIfs(text: string, depth = 0): boolean {
  if (text.includes("IFS")) return true;
  if (!maySpellIfs(text)) return false;
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch {
    return true;
  }
  return wordValues(tokens).some((v) => valueNamesIfs(v, depth));
}

function valueNamesIfs(value: string, depth: number): boolean {
  if (value.includes("IFS") || braceMaySpellIfs(value)) return true;
  if (!REQUOTED_RE.test(value)) return false;
  return depth + 1 >= RELEX_DEPTH ? maySpellIfs(value) : namesIfs(value, depth + 1);
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

/** Every word value in the tokens, including those inside command and process substitutions and redirects. */
function wordValues(tokens: readonly Token[]): string[] {
  return tokens.flatMap((t): string[] => {
    if (t.type === "word") return [t.value, ...t.subs.flatMap(wordValues)];
    if (t.type === "subs") return t.subs.flatMap(wordValues);
    if (t.type === "redirect") return [...(t.target ? [t.target.value] : []), ...(t.body === null ? [] : [t.body]), ...t.subs.flatMap(wordValues)];
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
