import { joinedDollar, nextAfter } from "./joins.js";
import { type Nesting, nested } from "./nesting.js";
import { ParseError, SplitParseError } from "./parse-error.js";
import { zshRunsValue } from "./zsh-value-flags.js";

/** The lexer's own readers, lent so a `${ }` or `$(( ))` body is read with the rules of the rest of the line. */
export interface NestedReaders {
  /** Lexes the `$( )` or `<( )` whose body starts at `start`; returns the index of its `)`. */
  substitution(start: number): number;
  /** Lexes the backtick substitution opening at `start`; returns the index of the closing backtick. */
  backtick(start: number): number;
  /** Collects substitutions in a single-quoted span, which bash still runs when the `${ }` sits in double quotes. */
  quotedSpan(from: number, to: number): void;
  /** Reads the `$((` at `dollar` as arithmetic or as `$( (…) … )`, as bash 5 does; returns its last index. */
  dollarParens(dollar: number): number;
  /** Shared with every reader of the command, so the recursion through them stops at `MAX_NESTING`. */
  nesting: Nesting;
  /** Set on bash 3.2's reading, which has no process substitutions here and checks nothing against itself. */
  bash32?: true;
}

const CLOSERS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };

/**
 * Index of the `}`, `)` or `]` closing the `${`, `$((` or `$[` whose brace, first paren or bracket is
 * at `open`. As in bash, quotes, escapes, `$'…'` and nested expansions hide a closer; an unquoted `(`
 * or `[` nests its own kind and an unquoted `{` does not, so `${x:-{}` ends at its first `}`.
 */
export function balancedEnd(src: string, open: number, read: NestedReaders): number {
  return nested(read.nesting, () => closerEnd(src, open, read));
}

function closerEnd(src: string, open: number, read: NestedReaders): number {
  const braces = src[open] === "{";
  const close = CLOSERS[src[open] ?? ""];
  let depth = 1;
  for (let j = open + 1; j < src.length; j++) {
    const c = src[j];
    if (c === close && --depth === 0) return j;
    if (c === src[open] && !braces) depth++;
    else j = constructEnd(src, j, read, braces);
  }
  throw new ParseError(`unterminated $${src[open]}`);
}

function constructEnd(src: string, j: number, read: NestedReaders, braces: boolean): number {
  const c = src[j];
  if (c === "\\") return j + 1;
  if (c === "'") return singleQuoteEnd(src, j, read);
  if (c === '"') return doubleQuoteEnd(src, j, read);
  if (c === "`") return read.backtick(j);
  if (c === "$") return dollarEnd(src, j, read);
  if (braces && !read.bash32 && (c === "<" || c === ">") && src[nextAfter(src, j)] === "(") return processEnd(src, nextAfter(src, j), read);
  return j;
}

/** How bash reads what follows a `$`, keyed by that character; the lexer and `dollarEnd` both dispatch from it. */
export type DollarOpener = "pid" | "braced" | "bracket" | "paren" | "ansi-c" | "locale";

export const DOLLAR_OPENERS: Readonly<Record<string, DollarOpener>> = {
  $: "pid",
  "{": "braced",
  "[": "bracket",
  "(": "paren",
  "'": "ansi-c",
  '"': "locale",
};

/** Characters after a `$` that open an expansion; a reader handed one the table does not list refuses the line. */
export const EXPANSION_OPENERS = "{[(";

/** Inside double quotes `$'` and `$"` are a literal `$` and a quote, not the ANSI-C and locale openers. */
export const QUOTED_LITERAL_OPENERS = "'\"";

/** The opener after the `$` at `j`, or null when bash reads that `$` as a name, a special parameter or text. */
export function dollarOpener(src: string, j: number): DollarOpener | null {
  const next = src[j + 1] ?? "";
  const opener = Object.hasOwn(DOLLAR_OPENERS, next) ? DOLLAR_OPENERS[next] : undefined;
  if (opener) return opener;
  if (next !== "" && EXPANSION_OPENERS.includes(next)) throw new SplitParseError(`no reader for $${next}`, "unclosed-expansion");
  return null;
}

const DOLLAR_ENDS: Record<DollarOpener, (src: string, j: number, read: NestedReaders) => number> = {
  pid: (_src, j) => j + 1,
  braced: (src, j, read) => balancedEnd(src, j + 1, read),
  bracket: (src, j, read) => balancedEnd(src, j + 1, read),
  paren: (src, j, read) => sameIn32(src, j + 1, src[nextAfter(src, j + 1)] === "(" ? read.dollarParens(j) : read.substitution(j + 2), read),
  "ansi-c": (src, j) => ansiCEnd(src, j + 1),
  locale: (_src, j) => j,
};

/** zsh runs the value of `${~x}`, `${(e)x}` and `$~x` as a glob qualifier or as code, so the line is refused where it is read. */
export function refuseValueRun(src: string, dollar: number): void {
  if (zshRunsValue(src, dollar)) throw new ParseError("zsh runs this expansion's value as code");
}

function dollarEnd(src: string, j: number, read: NestedReaders): number {
  const at = joinedDollar(src, j);
  refuseValueRun(src, at);
  const opener = dollarOpener(src, at);
  return opener ? DOLLAR_ENDS[opener](src, at, read) : at;
}

function singleQuoteEnd(src: string, start: number, read: NestedReaders): number {
  const end = src.indexOf("'", start + 1);
  if (end === -1) throw new ParseError("unterminated '");
  read.quotedSpan(start + 1, end);
  return end;
}

function doubleQuoteEnd(src: string, start: number, read: NestedReaders): number {
  for (let j = start + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '"') return j;
    if (c === "\\") j++;
    else if (c === "`") j = read.backtick(j);
    else if (c === "$" && !QUOTED_LITERAL_OPENERS.includes(src[joinedDollar(src, j) + 1] ?? "")) j = dollarEnd(src, j, read);
  }
  throw new ParseError('unterminated "');
}

export function ansiCEnd(src: string, quote: number): number {
  let end = quote + 1;
  while (end < src.length && src[end] !== "'") end += src[end] === "\\" ? 2 : 1;
  if (end >= src.length) throw new ParseError("unterminated $'");
  return end;
}

export function backtickEnd(src: string, start: number): number {
  let end = start + 1;
  while (end < src.length && src[end] !== "`") end += src[end] === "\\" ? 2 : 1;
  if (end >= src.length) throw new ParseError("unterminated `");
  return end;
}

/**
 * Bash 3.2 matches a `$( )` inside `${ }` or `$(( ))` by counting parens through quotes, blind to
 * heredocs, comments and case patterns; where that ends it elsewhere than bash 5, the line is refused.
 */
function sameIn32(src: string, open: number, end: number, read: NestedReaders): number {
  if (!read.bash32 && in32(() => balancedEnd(src, open, bash32Readers(src, read.nesting))) !== end) {
    throw new SplitParseError("bash 3.2 ends a substitution inside an expansion elsewhere", "nested-substitution");
  }
  return end;
}

/** Bash 5 reads a `<( )` inside `${ }` to its `)`; bash 3.2 reads its text as part of the parameter, so a `}` or a construct crossing that `)` splits them. */
function processEnd(src: string, paren: number, read: NestedReaders): number {
  const end = read.substitution(paren + 1);
  if (in32(() => plainEnd(src, paren + 1, end, read.nesting)) !== end) {
    throw new SplitParseError("bash 3.2 ends ${ } inside a process substitution", "procsub-brace");
  }
  return end;
}

/** Where bash 3.2, reading `src` from `from` inside `${ }`, first reaches `to` or a `}`. */
function plainEnd(src: string, from: number, to: number, nesting: Nesting): number {
  const read = bash32Readers(src, nesting);
  let j = from;
  while (j < to && src[j] !== "}") j = constructEnd(src, j, read, true) + 1;
  return j;
}

function in32(find: () => number): number {
  try {
    return find();
  } catch (error) {
    if (error instanceof ParseError) return -1;
    throw error;
  }
}

function bash32Readers(src: string, nesting: Nesting): NestedReaders {
  const read: NestedReaders = {
    substitution: (start) => balancedEnd(src, start - 1, read),
    backtick: (start) => backtickEnd(src, start),
    quotedSpan: () => undefined,
    dollarParens: (dollar) => balancedEnd(src, dollar + 1, read),
    nesting,
    bash32: true,
  };
  return read;
}
