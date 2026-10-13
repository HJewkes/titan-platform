import { type Scripts, scriptsOf, selectsStartupFile, tokenLists } from "./ifs-scripts.js";
import { mayWriteRunTimeName } from "./ifs-writes.js";
import { tokenize } from "./lexer.js";
import type { Token, WordToken } from "./tokens.js";
import { ASSIGNMENT_RE, type Vars } from "./vars.js";

const DEFAULT_IFS = " \t\n";
/** A range whose ends are not both numbers may cover I, F or S. */
const LETTER_RANGE_RE = /(?:^|[^0-9-])\.\.|\.\.(?:[^0-9-]|$)/;
/**
 * Text that may build a name at run time (an expansion, a backquote, a glob, a brace), source a file, or reach an
 * arithmetic sink (an integer or float attribute, a mapfile callback), or select a shell startup file.
 */
const RUN_TIME_TEXT_RE = /[$`?*[{]|source|integer|float|ENV|ZDOTDIR|--(?:login|rcfile|init-file|interactive)|(?:^|[\s;&|(])\.\s|\s[-+][A-Za-z0-9]*[iCEFl]/;
/** The walk's own nesting limit (`MAX_DEPTH` in commands.ts); past it the value counts as naming IFS. */
const RELEX_DEPTH = 8;

/**
 * Whether the text may write IFS: a word spells IFS once quotes, escapes, line continuations and `$'…'` are
 * removed and braces expanded (`declare I\FS=,`, `read {I,}FS`), a write slot's name is built at run time
 * (`declare $a$b$c=,`, `read ?FS`), a script the walk runs does either, or such a script is only known at run time.
 * Where this model of bash runs out, it answers true.
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
  const startup = selectsStartupFile(tokens);
  return tokenLists(tokens).some((list) => listNamesIfs(list, text.length, startup, depth));
}

function listNamesIfs(list: Token[], srcLength: number, startup: boolean, depth: number): boolean {
  if (mayWriteRunTimeName(list) || wordValues(list).some(valueSpellsIfs)) return true;
  let scripts: Scripts;
  try {
    scripts = scriptsOf(list, srcLength);
  } catch {
    // Past the spliced-text budget the walk refuses the line, so this answers true with it.
    return true;
  }
  if (scripts.runTime || (startup && scripts.startsShell)) return true;
  return scripts.texts.some((code) => depth + 1 >= RELEX_DEPTH || namesIfs(code, depth + 1));
}

function valueSpellsIfs(value: string): boolean {
  return value.includes("IFS") || braceMaySpellIfs(value);
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
