const IDENTIFIER_CHAR_RE = /[A-Za-z0-9_]/;
/** Characters a compound assignment operator puts before its `=`: `+=`, `**=`, `<<=`, zsh `||=`. */
const OPERATOR_CHARS = "+-*/%&^|<>";
/** What ends an expansion, which only a dynamic word holds: `${…}`, `$(…)`, backquotes, `$x`, `$@`, `$#`, `$!`. */
const EXPANSION_BEFORE = new Set(["}", ")", "`", "$", "@", "#", "!"]);
/** What a later rewrite of literal text may turn into a name: a printf directive `%s` or an escape `\x34`. */
const REWRITE_BEFORE = new Set(["\\", "%"]);
/** What ends a glob, which only an unquoted word expands. */
const GLOB_BEFORE = new Set(["*", "?", "]"]);

/** How the shell treats a word's text: which expansions it holds or undergoes. */
export interface HandedText {
  text: string;
  /** It holds a `$` or backquote expansion. */
  dynamic: boolean;
  /** Some of it is unquoted, so a brace list in it expands. */
  braces: boolean;
  /** None of it is quoted, so a glob in it expands. */
  globs: boolean;
  /** Where each `$( )` or backquote's output lands in `text`, which leaves it out. */
  cuts: number[];
}
/** Past this a subscript before an `=` is not scanned back, and the name counts as computed. */
const MAX_SUBSCRIPT = 256;

/**
 * Whether an assignment in the text, once a shell stores and evaluates it, may bind a name the shell computes. The
 * name an `=` binds is the identifier run just before it, after any subscript; it is computed when an expansion or
 * rewrite ends right before that run: `PS{4,}=7`, `"${v:-PS4}=7"`, `"$(echo PS4)=7"`, `"${x}4=7"`, printf's
 * `'%s=7'` and `'PS\x34=7'`, or an unquoted glob `P?4=7`. Any of these may bind a hooked name, so it counts; a
 * literal run is read as written elsewhere. A single-quoted `'{$1=""}'` holds no expansion, and a stored value is
 * not expanded again when math reads it. Every scan stops at the previous `=` or a bounded subscript, so the
 * read is linear.
 */
export function bindsComputedName({ text, dynamic, braces, globs, cuts }: HandedText): boolean {
  for (let eq = text.indexOf("="); eq >= 0; eq = text.indexOf("=", eq + 1)) {
    if (isComparison(text, eq)) continue;
    const start = boundNameStart(text, eq);
    if (start === null) return true;
    const before = text.charAt(start - 1);
    if (cuts.includes(start)) return true;
    if (REWRITE_BEFORE.has(before) || (dynamic && EXPANSION_BEFORE.has(before))) return true;
    if ((braces && before === "}") || (globs && GLOB_BEFORE.has(before))) return true;
  }
  return false;
}

/** `==`, `!=`, `<=` and `>=` compare; `<<=` and `>>=` assign. */
function isComparison(text: string, eq: number): boolean {
  const prev = text.charAt(eq - 1);
  if (text.charAt(eq + 1) === "=" || prev === "=" || prev === "!") return true;
  return (prev === "<" || prev === ">") && text.charAt(eq - 2) !== prev;
}

/** Where the name an `=` binds starts, or null when its subscript is too long to scan back. */
function boundNameStart(text: string, eq: number): number | null {
  let i = eq;
  while (i > 0 && eq - i < 2 && OPERATOR_CHARS.includes(text.charAt(i - 1))) i--;
  if (text.charAt(i - 1) === "]") {
    const open = openingBracket(text, i - 1);
    if (open === null) return null;
    i = open;
  }
  while (i > 0 && IDENTIFIER_CHAR_RE.test(text.charAt(i - 1))) i--;
  return i;
}

function openingBracket(text: string, close: number): number | null {
  for (let i = close - 1; i >= 0 && close - i <= MAX_SUBSCRIPT; i--) if (text[i] === "[") return i;
  return null;
}
