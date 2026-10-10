import { ParseError, SplitParseError } from "./parse-error.js";

/** The lexer's own readers, lent so a `${ }` or `$(( ))` body is read with the rules of the rest of the line. */
export interface NestedReaders {
  /** Lexes the `$( )` or `<( )` whose body starts at `start`; returns the index of its `)`. */
  substitution(start: number): number;
  /** Lexes the backtick substitution opening at `start`; returns the index of the closing backtick. */
  backtick(start: number): number;
  /** Collects substitutions in a single-quoted span, which bash still runs when the `${ }` sits in double quotes. */
  quotedSpan(from: number, to: number): void;
}

/**
 * Index of the `}` or `)` closing the `${` or `$((` whose brace or first paren is at `open`. As in
 * bash, quotes, escapes, `$'…'` and nested expansions hide a closer; an unquoted `(` nests and an
 * unquoted `{` does not, so `${x:-{}` ends at its first `}`.
 */
export function balancedEnd(src: string, open: number, read: NestedReaders): number {
  const braces = src[open] === "{";
  const close = braces ? "}" : ")";
  let depth = 1;
  for (let j = open + 1; j < src.length; j++) {
    const c = src[j];
    if (c === close && --depth === 0) return j;
    if (c === "(" && !braces) depth++;
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
  if (braces && (c === "<" || c === ">") && src[j + 1] === "(") return processEnd(src, j, read);
  return j;
}

function dollarEnd(src: string, j: number, read: NestedReaders): number {
  const next = src[j + 1];
  if (next === "{" || (next === "(" && src[j + 2] === "(")) return balancedEnd(src, j + 1, read);
  if (next === "(") return read.substitution(j + 2);
  if (next === "'") return ansiCEnd(src, j + 1);
  return j;
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
    else if (c === "$" && src[j + 1] !== "'") j = dollarEnd(src, j, read);
  }
  throw new ParseError('unterminated "');
}

export function ansiCEnd(src: string, quote: number): number {
  let end = quote + 1;
  while (end < src.length && src[end] !== "'") end += src[end] === "\\" ? 2 : 1;
  if (end >= src.length) throw new ParseError("unterminated $'");
  return end;
}

/** Bash 5 reads a `<( )` inside `${ }` to its `)`, bash 3.2 to the first `}`, so a `}` inside one is refused. */
function processEnd(src: string, j: number, read: NestedReaders): number {
  const end = read.substitution(j + 2);
  if (src.slice(j, end).includes("}")) throw new SplitParseError("a } inside a process substitution in ${ } ends it early in bash 3.2", "procsub-brace");
  return end;
}
