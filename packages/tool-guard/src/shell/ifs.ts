import { tokenize } from "./lexer.js";
import type { Token, WordToken } from "./tokens.js";
import { ASSIGNMENT_RE, type Vars } from "./vars.js";

const DEFAULT_IFS = " \t\n";
/** Quoting a word's value may still hold, so an `eval` or `sh -c` text re-lexes to IFS. */
const REQUOTED_RE = /[\\'"$]/;
/** Lexing a value inside a value ends here; a deeper spelling of IFS needs a parse the guard refuses anyway. */
const RELEX_DEPTH = 3;
const BRACE_GROUP_RE = /\{([^{}]*)\}/;
/** More brace words than this from one word reads as naming IFS rather than spend time expanding. */
const BRACE_LIMIT = 256;

/**
 * Whether any word of the text spells IFS once quotes, escapes, line continuations and `$'…'` are removed
 * and braces expanded, so `declare I\FS=,` or `read {I,}FS` counts as a write the walk may reach late.
 */
export function namesIfs(text: string, depth = 0): boolean {
  if (text.includes("IFS")) return true;
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch {
    // The guard refuses a line it cannot parse; a value that does not parse is no command text.
    return false;
  }
  return wordValues(tokens).some((v) => valueNamesIfs(v, depth));
}

function valueNamesIfs(value: string, depth: number): boolean {
  if (braceWords(value).some((w) => w.includes("IFS"))) return true;
  return depth < RELEX_DEPTH && REQUOTED_RE.test(value) && namesIfs(value, depth + 1);
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

/** Bash brace expansion of comma lists and single-character ranges, innermost group first; numeric ranges never spell a letter. */
function braceWords(value: string): string[] {
  let words = [value];
  while (words.some((w) => BRACE_GROUP_RE.test(w))) {
    words = words.flatMap(expandOneGroup);
    if (words.length > BRACE_LIMIT) return ["IFS"];
  }
  return words;
}

function expandOneGroup(word: string): string[] {
  const m = BRACE_GROUP_RE.exec(word);
  if (!m) return [word];
  const before = word.slice(0, m.index);
  const after = word.slice(m.index + m[0].length);
  return groupItems(m[1] ?? "").map((item) => before + item + after);
}

function groupItems(body: string): string[] {
  const range = /^(.)\.\.(.)(?:\.\.-?\d+)?$/s.exec(body);
  if (range?.[1] && range[2]) return charRange(range[1], range[2]);
  return body.includes(",") ? body.split(",") : [body];
}

function charRange(from: string, to: string): string[] {
  const [lo, hi] = [from.charCodeAt(0), to.charCodeAt(0)].sort((a, b) => a - b) as [number, number];
  return Array.from({ length: hi - lo + 1 }, (_, i) => String.fromCharCode(lo + i));
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
