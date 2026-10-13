const IDENTIFIER_CHAR_RE = /[A-Za-z0-9_]/;
const SPACE_RE = /\s/;
/** Characters a compound assignment operator puts before its `=`: `+=`, `**=`, `<<=`, zsh `||=`, `^^=`. */
const OPERATOR_CHARS = "+-*/%&^|<>";
/** What ends an expansion, which only a dynamic text holds: `${…}`, `$(…)`, backquotes, `$x`, `$@`, `$#`, `$!`. */
const EXPANSION_END = new Set(["}", ")", "`", "$", "@", "#", "!"]);
/** What starts one. */
const EXPANSION_START = new Set(["$", "`"]);
/** What a later rewrite of a word may turn into a name: a printf directive `%s` or an escape `\x34`. */
const REWRITE = new Set(["\\", "%"]);
/** What ends or starts a glob, which only an unquoted word expands. */
const GLOB_END = new Set(["*", "?", "]"]);
const GLOB_START = new Set(["*", "?", "["]);
/** Past this a subscript is not scanned, and the read fails closed. */
const MAX_SCAN = 256;

/** How the shell treats a text: which expansions it holds or undergoes. */
export interface HandedText {
  text: string;
  /** It holds a `$` or backquote expansion. */
  dynamic: boolean;
  /** Some of it is unquoted, so a brace list in it expands. */
  braces: boolean;
  /** None of it is quoted, so a glob in it expands. */
  globs: boolean;
  /** It is a word, which printf or `echo -e` may rewrite. */
  rewrites: boolean;
  /** Where each `$( )` or backquote's output lands in `text`, which leaves it out. */
  cuts: number[];
}

/**
 * Whether a math write in the text, once a shell stores and evaluates it, may bind a name the shell computes. Every
 * write operator anchors: `=` and each compound `op=` and a postfix `++`/`--` bind the identifier run before them,
 * past any whitespace and subscript; a prefix `++`/`--` binds the run after it. The name is computed when an
 * expansion, rewrite or glob ends just before that run or starts at or just after it: `"${x} = 7"`, `"$x"$'\t=7'`,
 * `"++$x"`, `'%s++'`. An `=` in a `${…}` pattern operand anchors too: math expanded inside a pattern still runs
 * (`${x#$(( ${y}=1 ))}`), so `${line#*=}` is an accepted over-read. Each scan stops at the next operator or a
 * bound, so the read is linear.
 */
export function bindsComputedName(handed: HandedText): boolean {
  const { text } = handed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "=" && !isComparison(text, i) && computedBefore(handed, compoundStart(text, i))) return true;
    const step = text.charAt(i + 1) === ch && (ch === "+" || ch === "-");
    if (step && (computedBefore(handed, i) || computedAfter(handed, i + 2))) return true;
    if (step) i++;
  }
  return false;
}

/** `==`, `!=`, `<=` and `>=` compare; `<<=` and `>>=` assign. */
function isComparison(text: string, eq: number): boolean {
  const prev = text.charAt(eq - 1);
  if (text.charAt(eq + 1) === "=" || prev === "=" || prev === "!") return true;
  return (prev === "<" || prev === ">") && text.charAt(eq - 2) !== prev;
}

/** Where the operator ending in the `=` at `eq` starts: `**=`, `<<=`, `||=` take up to three characters. */
function compoundStart(text: string, eq: number): number {
  let i = eq;
  while (i > 0 && eq - i < 2 && OPERATOR_CHARS.includes(text.charAt(i - 1))) i--;
  return i;
}

/** Whether the name an operator starting at `at` binds before it is computed. */
function computedBefore({ text, dynamic, braces, globs, rewrites, cuts }: HandedText, at: number): boolean {
  let i = skipSpaceBack(text, at);
  if (text.charAt(i - 1) === "]") {
    const open = openingBracket(text, i - 1);
    if (open < 0) return true;
    i = skipSpaceBack(text, open);
  }
  while (i > 0 && IDENTIFIER_CHAR_RE.test(text.charAt(i - 1))) i--;
  const before = text.charAt(i - 1);
  if (cuts.includes(i) || (rewrites && REWRITE.has(before)) || (dynamic && EXPANSION_END.has(before))) return true;
  return (braces && before === "}") || (globs && GLOB_END.has(before));
}

/** Whether the name a prefix `++`/`--` ending at `from` binds after it is computed. */
function computedAfter({ text, dynamic, braces, globs, rewrites, cuts }: HandedText, from: number): boolean {
  let i = from;
  while (i < text.length && SPACE_RE.test(text.charAt(i))) i++;
  const opens = (at: number) => {
    const ch = text.charAt(at);
    if (cuts.includes(at) || (rewrites && REWRITE.has(ch)) || (dynamic && EXPANSION_START.has(ch))) return true;
    return (braces && ch === "{") || (globs && GLOB_START.has(ch));
  };
  if (opens(i)) return true;
  while (i < text.length && IDENTIFIER_CHAR_RE.test(text.charAt(i))) i++;
  return i > from && opens(i);
}

/** The `[` that opens the subscript closing at `close`, or -1 within `MAX_SCAN` characters. */
function openingBracket(text: string, close: number): number {
  for (let i = close - 1; i >= 0 && close - i <= MAX_SCAN; i--) if (text[i] === "[") return i;
  return -1;
}

function skipSpaceBack(text: string, at: number): number {
  let i = at;
  while (i > 0 && SPACE_RE.test(text.charAt(i - 1))) i--;
  return i;
}
