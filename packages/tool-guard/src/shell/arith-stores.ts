import type { RedirectToken, WordToken } from "./lexer.js";
import { NAMED_FD_RE } from "./lexer.js";

/** What a shell reads as a store in math: an assignment operator (zsh adds `&&=`, `||=`, `^^=`) or an increment. */
const STORE_OPERATOR = String.raw`(?:\*\*|<<|>>|&&|\|\||\^\^|[-+*/%&^|])?=(?!=)|\+\+|--`;
/** Expansions that yield a number or a flag a script cannot shape: `$#`, `$?`, `$$`, `$!`, `${#x}`, zsh `$+x`. */
const NUMERIC_EXPANSION_RE = /\$[#?$!]|\$\{#(?:[A-Za-z_]\w*(?:\[[^\]$`]*\])?)?\}|\$\+[A-Za-z_]\w*(?:\[[^\]$`]*\])?/g;
const ARITHMETIC_OPENER_RE = /\$\(\(|\$\[/g;
/** Where a subscript opens in an expansion: after `${name` or `$name`. */
const EXPANSION_SUBSCRIPT_RE = /\$\{[^}\s]*?[A-Za-z0-9_@*]\[|\$[A-Za-z_]\w*\[/g;
/** An unquoted word that begins as a name with a subscript, which the shell takes as an element assignment: `a[$i]=1`. */
const ASSIGNED_SUBSCRIPT_RE = /^[A-Za-z_]\w*\[/;

/** Past this length a math text is not read: the reader scans each subscript, so a long run of openers would cost quadratic time. */
const MAX_MATH_TEXT = 1024;

/**
 * A reader of arithmetic that stores into any of `names`: `commands[y]=0`, `x+=1`, `BASH_CMDS[y]++`, `--functions`.
 * One list serves every caller; TP-3295 passes the exec-hook parameters through the same readers.
 */
export function storeReader(names: ReadonlySet<string>): RegExp {
  const name = `(?<![A-Za-z0-9_])(?:${[...names].join("|")})(?![A-Za-z0-9_])`;
  return new RegExp(`${name}(?:\\[.*?\\])?\\s*(?:${STORE_OPERATOR})|(?:\\+\\+|--)\\s*${name}`, "s");
}

/**
 * Whether the math text may store into a name: a literal store, or a run-time expansion that may hold one
 * (`e='commands[y]=0'; (( $e ))`). A dynamic text counts unless every expansion in it yields a number.
 */
function mathStores(text: string, dynamic: boolean, reader: RegExp): boolean {
  if (text.length > MAX_MATH_TEXT || reader.test(text)) return true;
  if (!dynamic) return false;
  return /[$`]/.test(text.replace(NUMERIC_EXPANSION_RE, "").replace(ARITHMETIC_OPENER_RE, ""));
}

/** Whether any word is wholly math, as every operand of `let`, `shift` or an `(( ))` body is. */
export function operandsStore(words: Array<{ value: string; dynamic: boolean }>, reader: RegExp): boolean {
  return words.some((word) => mathStores(word.value, word.dynamic, reader));
}

/**
 * Whether a dynamic word holds math that may store: the body of a `$(( ))` or `$[ ]`, or the subscript of an
 * element read or named, which the shell evaluates as math when the array is not associative.
 */
export function embeddedMathStores(words: WordToken[], reader: RegExp): boolean {
  return words.filter((w) => w.dynamic).some((w) => embeddedSpans(w).some((span) => mathStores(span, true, reader)));
}

/** The outermost spans: an opener inside an earlier span is read with it, which keeps the scan linear. */
function embeddedSpans({ value: text, quoted }: WordToken): string[] {
  const assigned = quoted ? null : ASSIGNED_SUBSCRIPT_RE.exec(text);
  const openers = [...text.matchAll(ARITHMETIC_OPENER_RE), ...text.matchAll(EXPANSION_SUBSCRIPT_RE), ...(assigned ? [assigned] : [])];
  const spans: string[] = [];
  let past = 0;
  for (const opener of openers.sort((x, y) => x.index - y.index)) {
    const from = opener.index + opener[0].length;
    if (from <= past) continue;
    const double = opener[0] === "$((";
    past = closeAt(text, from, double ? "(" : "[", double ? ")" : "]", double ? 2 : 1);
    spans.push(text.slice(from, past));
  }
  return spans;
}

/** Index where nesting returns to zero, or the text's end when it never does (an unclosed span is read to the end). */
function closeAt(text: string, from: number, open: string, close: string, depth: number): number {
  let left = depth;
  for (let i = from; i < text.length; i++) {
    if (text[i] === open) left++;
    else if (text[i] === close && --left === 0) return i;
  }
  return text.length;
}

/**
 * Whether a redirect stores its descriptor number into one of `names` (`exec {BASH_CMDS[y]}>f`), or into an element
 * whose subscript, evaluated as math, may store (`{a[$e]}>f`).
 */
export function fdVariableStores(redirects: RedirectToken[], names: ReadonlySet<string>, reader: RegExp): boolean {
  return redirects.some((r) => {
    const match = NAMED_FD_RE.exec(r.named ?? r.fd ?? "");
    if (match?.[1] === undefined) return false;
    const subscript = match[2]?.slice(1, -1);
    return names.has(match[1]) || (subscript !== undefined && mathStores(subscript, /[$`]/.test(subscript), reader));
  });
}
