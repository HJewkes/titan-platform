import type { Token, WordToken } from "./lexer.js";
import type { Assignment, Vars } from "./vars.js";

export const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A target may carry a subscript: bash writes one element, so the whole variable is no longer what it was. */
export const TARGET_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[.*\])?$/s;
/** A name not inside a number such as `0x1F` or `16#ff`, nor after a `$`. */
const NAME_RE = /(?<![\w$#])[A-Za-z_]\w*/g;
/** An assignment operator, but no comparison such as `==`, `<=` or `!=`, or an increment after the name. */
const WRITTEN_AFTER_RE = /^\s*(?:\[.*\])?\s*(?:(?:<<|>>|[-+*/%&^|])?=(?!=)|\+\+|--)/s;
const WRITTEN_BEFORE_RE = /(?:\+\+|--)\s*$/;

/**
 * What a command writes without a plain assignment, every value unknown. Null means the command may write any
 * variable. Only a shell identifier is written: bash rejects any other target, so a hidden slot stays out of
 * reach. Even a literal `let Y=1` stays unknown: the walk cannot tell that the `let` surely runs, in this shell.
 */
export function commandWrites(name: string, args: WordToken[], vars: Vars): Assignment[] | null {
  const own = builtinWrites(name, args, vars);
  const expansions = args.flatMap((a) => expansionBodies(a.value));
  const inner = expansions.length > 0 ? arithmeticWrites(expansions, vars) : [];
  return own && inner && [...own, ...inner];
}

function builtinWrites(name: string, args: WordToken[], vars: Vars): Assignment[] | null {
  const values = args.map((a) => a.value);
  const unknown = (names: string[]): Assignment[] => names.map((n) => [n, null]);
  if (name === "let") return args.some(runTimeExpression) ? null : arithmeticWrites(values, vars);
  if (name === "read" || name === "unset") return unknown(values.flatMap((v) => TARGET_RE.exec(v)?.[1] ?? []));
  if ((name === "for" || name === "select") && values[0] !== undefined && IDENTIFIER_RE.test(values[0])) return unknown([values[0]]);
  if (name === "getopts") return unknown(["OPTARG", "OPTIND", ...values.slice(1, 2).filter((v) => IDENTIFIER_RE.test(v))]);
  if (name === "mapfile" || name === "readarray") return unknown(["MAPFILE", ...values.filter((v) => IDENTIFIER_RE.test(v))]);
  return [];
}

/** Bash expands `$` and backquotes in the expression itself, so text it expands may name any variable. */
function runTimeExpression(w: WordToken): boolean {
  return w.dynamic || /[$`]/.test(w.value);
}

function writtenNames(expression: string): string[] {
  return [...expression.matchAll(NAME_RE)]
    .filter((m) => WRITTEN_AFTER_RE.test(expression.slice(m.index + m[0].length)) || WRITTEN_BEFORE_RE.test(expression.slice(0, m.index)))
    .map((m) => m[0]);
}

/** The tokens inside each `(( ))`, keyed by its first `(`. */
const compounds = new WeakMap<Token, Token[]>();

/**
 * Notes each `(( ))`, which the lexer reads as two parentheses. `( (a) )` reads the same, so a write found
 * there leaves the value unknown rather than exact. Returns the tokens unchanged.
 */
export function noteCompounds(tokens: Token[]): Token[] {
  tokens.forEach((token, i) => {
    const end = isOp(tokens[i + 1], "(") ? compoundEnd(tokens, i + 2) : -1;
    if (isOp(token, "(") && end > 0) compounds.set(token, tokens.slice(i + 2, end - 1));
  });
  return tokens;
}

/** The index of the second `)` that closes a `((` opened before `start`, or -1 when none does. */
function compoundEnd(tokens: Token[], start: number): number {
  let depth = 2;
  for (let i = start; i < tokens.length; i++) {
    if (isOp(tokens[i], "(")) depth++;
    if (!isOp(tokens[i], ")")) continue;
    depth--;
    if (depth === 1 && !isOp(tokens[i + 1], ")")) return -1;
    if (depth === 0) return i;
  }
  return -1;
}

const isOp = (token: Token | undefined, value: string) => token?.type === "op" && token.value === value;

/** What the `(( ))` the token opens writes, each value unknown; an empty list when it opens none. */
export function compoundWrites(op: Token, expand: (w: WordToken) => WordToken, vars: Vars): Assignment[] | null {
  const span = compounds.get(op);
  if (!span) return [];
  const words = span.flatMap((t) => (t.type === "word" ? [expand(t)] : t.type === "redirect" && t.target ? [expand(t.target)] : []));
  if (span.some((t) => t.type === "subs") || words.some(runTimeExpression)) return null;
  return arithmeticWrites([span.map((t) => compoundText(t, expand)).join(" ")], vars);
}

/** The lexer reads `<` and `>` in an expression as redirections; `Y>>=1` keeps its operator whole. */
function compoundText(t: Token, expand: (w: WordToken) => WordToken): string {
  if (t.type === "word") return expand(t).value;
  if (t.type === "redirect") return t.op + (t.target ? expand(t.target).value : "");
  return t.type === "op" ? t.value : "";
}

/** The text inside each `$(( ))` of a word, which writes in the current shell wherever the word sits. */
function expansionBodies(value: string): string[] {
  const bodies: string[] = [];
  for (let at = value.indexOf("$(("); at >= 0; at = value.indexOf("$((", at + 3)) {
    let depth = 0;
    let end = at + 2;
    for (; end < value.length; end++) {
      if (value[end] === "(") depth++;
      if (value[end] === ")" && --depth === 0) break;
    }
    bodies.push(value.slice(at + 3, end - 1));
  }
  return bodies;
}

/**
 * Every name the expressions write, unknown: those the text assigns, and those a read name's value assigns,
 * since bash evaluates that value as an expression too. A value that is unknown, or expands, may write any name.
 */
function arithmeticWrites(expressions: string[], vars: Vars): Assignment[] | null {
  const written = new Set<string>();
  const seen = new Set<string>();
  const pending = [...expressions];
  for (let text = pending.pop(); text !== undefined; text = pending.pop()) {
    if (/[$`]/.test(text)) return null;
    for (const name of writtenNames(text)) written.add(name);
    for (const name of text.matchAll(NAME_RE)) {
      if (seen.has(name[0]) || !vars.has(name[0])) continue;
      seen.add(name[0]);
      const value = vars.get(name[0]) ?? null;
      if (value === null) return null;
      pending.push(value);
    }
  }
  return [...written].map((n) => [n, null]);
}
