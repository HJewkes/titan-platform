/** Stands in for an expansion, quote or substitution the math scan skipped whole: its text is unknown until run time. */
const OPAQUE = "\uE000";

export const CUT_OFF = Symbol("cut off");

const SCAN_RE = /[()[\]{}$`'"\\]/g;
const NAME_AT_RE = /[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[-@*#?$!]/y;
/** Inside double quotes `$'` and `$"` are a literal `$` and a quote, not the ANSI-C and locale openers. */
export const QUOTED_LITERAL_OPENERS = "'\"";
const UNIT_CLOSE = new Map([["(", ")"], ["{", "}"], ["[", "]"]]);
const OPENER_OF = new Map([[")", "("], ["]", "["]]);

interface MathSpan {
  end: number;
  flat: string;
  /** A `)` with no opener before a `))`: bash reads the subshell `$((echo hi); echo there)`. `end` is then the end of the text. */
  unpaired: boolean;
}

/**
 * Where the math in `text` from `from` ends at `close`, outside nested groups, and the text with each nested expansion,
 * quote and substitution replaced by OPAQUE. Those are skipped whole: bash drops the brackets inside `${y+]}` or `'('`
 * when it expands them, so they must not count toward the close. As in the lexer, only the close's own kind of
 * bracket nests, and none nests before a `}`. A `)` on the text's last character may be half a `))`, so it is cut off.
 */
export function closeOf(text: string, from: number, close: string): MathSpan | typeof CUT_OFF {
  const opener = close === "}" ? "" : OPENER_OF.get(close.charAt(0));
  let depth = 0;
  let flat = "";
  let copied = from;
  SCAN_RE.lastIndex = from;
  for (let at = SCAN_RE.exec(text); at !== null; at = SCAN_RE.exec(text)) {
    const i = at.index;
    const c = text.charAt(i);
    if (depth === 0 && text.startsWith(close, i)) return { end: i, flat: flat + text.slice(copied, i), unpaired: false };
    if (c === "$" || c === "`" || c === "'" || c === '"' || c === "\\") {
      const next = skipUnit(text, i);
      if (next < 0) return CUT_OFF;
      if (next === i) continue;
      flat += text.slice(copied, i) + (c === "\\" ? "" : OPAQUE);
      copied = next;
      SCAN_RE.lastIndex = next;
    } else if (c === opener) depth++;
    else if (c === close.charAt(0) && --depth < 0) {
      return i + 1 < text.length ? { end: text.length, flat: flat + text.slice(copied), unpaired: true } : CUT_OFF;
    }
  }
  return CUT_OFF;
}

/** The index after the unit that starts at `i`, `i` itself when none starts there, or -1 when it does not close in the text. */
function skipUnit(text: string, i: number): number {
  const c = text.charAt(i);
  if (c === "\\") return Math.min(text.length, i + 2);
  if (c === "'") return quoteEnd(text, i + 1, "'");
  if (c === '"') return dquoteEnd(text, i + 1);
  if (c === "`") return quoteEnd(text, i + 1, "`");
  const next = text.charAt(i + 1);
  if (next === "'") return quoteEnd(text, i + 2, "'");
  if (next === '"') return dquoteEnd(text, i + 2);
  const close = UNIT_CLOSE.get(next);
  if (close !== undefined) return groupEnd(text, i + 2, next, close);
  NAME_AT_RE.lastIndex = i + 1;
  const name = NAME_AT_RE.exec(text)?.[0];
  return name === undefined ? i : i + 1 + name.length;
}

/** The index after the next `quote` that no backslash escapes, or -1. A backslash escapes in `$'…'` and backticks, and harmlessly in `'…'`. */
function quoteEnd(text: string, from: number, quote: string): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === quote) return i + 1;
    if (text[i] === "\\" && quote !== "'") i++;
  }
  return -1;
}

/** The index after a double-quoted string, which holds its own expansions; there `$'` and `$"` are a plain `$` and a quote. */
function dquoteEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === '"') return i + 1;
    if (c === "\\") i++;
    else if ((c === "$" && !QUOTED_LITERAL_OPENERS.includes(text.charAt(i + 1))) || c === "`") {
      const next = skipUnit(text, i);
      if (next < 0) return -1;
      i = Math.max(i, next - 1);
    }
  }
  return -1;
}

/**
 * The index after the `${`, `$(`, `$((` or `$[` group whose body starts at `from`. A `${` ends at its first `}`,
 * since bash counts no bare braces there; the others count their own bare brackets.
 */
function groupEnd(text: string, from: number, open: string, close: string): number {
  let depth = 0;
  SCAN_RE.lastIndex = from;
  for (let at = SCAN_RE.exec(text); at !== null; at = SCAN_RE.exec(text)) {
    const i = at.index;
    const c = text.charAt(i);
    if (c === close && depth === 0) return i + 1;
    if (c === close) depth--;
    else if (c === open && open !== "{") depth++;
    else if (c === "$" || c === "`" || c === "'" || c === '"' || c === "\\") {
      const next = skipUnit(text, i);
      if (next < 0) return -1;
      SCAN_RE.lastIndex = Math.max(next, i + 1);
    }
  }
  return -1;
}
