import type { Token, WordToken } from "./lexer.js";
import { onPathLine } from "./path-commands.js";

/** Hidden key marking a name whose unknown value is a number: arithmetic wrote it, or it holds a count, a length or a status. */
export const numericKey = (name: string) => `numeric@${name}`;

/** Math reads such a name as a number, never as a store, and a number written to it needs no tracking. */
export const isNumeric = (vars: ReadonlyMap<string, string | null>, name: string) => vars.has(numericKey(name));

/** A value that is only digits however it comes out: the status or a count, `${#x}`. */
const NUMERIC_VALUE_RE = /^"?(?:\$[?#$!]|\$\{#[A-Za-z_]\w*(?:\[@*\])?\})"?$/;

/**
 * Whether the assigned value is only digits: a numeric expansion, or the one substitution `$(wc -l < f)`, where `wc` reads
 * its input alone (a file operand would print the name). Math reads such a name as a number, never as a store.
 */
export function numericValue(w: WordToken): boolean {
  const text = w.value.slice(w.value.indexOf("=") + 1);
  if (NUMERIC_VALUE_RE.test(text)) return true;
  const [only] = w.subs;
  return onPathLine(w) && text === "" && w.subs.length === 1 && only !== undefined && countsInput(only);
}

function countsInput(tokens: Token[]): boolean {
  const words = tokens.filter((t): t is WordToken => t.type === "word");
  const [command, ...options] = words;
  const plain = tokens.every((t) => t.type === "word" || (t.type === "redirect" && t.op === "<"));
  return plain && command?.value === "wc" && options.every((o) => !o.dynamic && /^-[a-zA-Z]+$/.test(o.value));
}
