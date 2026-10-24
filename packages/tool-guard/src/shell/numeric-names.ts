import type { WordToken } from "./lexer.js";
import { numericOutput } from "./numeric-output.js";
import { onPathLine } from "./path-commands.js";

/** Hidden key marking a name whose unknown value is a number: arithmetic wrote it, or it holds a count, a length or a status. */
export const numericKey = (name: string) => `numeric@${name}`;

/** Math reads such a name as a number, never as a store, and a number written to it needs no tracking. */
export const isNumeric = (vars: ReadonlyMap<string, string | null>, name: string) => vars.has(numericKey(name));

/** A value that is only digits however it comes out: the status or a count, `${#x}`. */
const NUMERIC_VALUE_RE = /^"?(?:\$[?#$!]|\$\{#[A-Za-z_]\w*(?:\[@*\])?\})"?$/;

/**
 * Whether the assigned value is only digits: a numeric expansion, or one substitution whose output is digits
 * (`numericOutput`) on a line where nothing rebinds the command it runs. Math reads such a name as a number.
 */
export function numericValue(w: WordToken): boolean {
  const text = w.value.slice(w.value.indexOf("=") + 1);
  if (NUMERIC_VALUE_RE.test(text)) return true;
  const [only] = w.subs;
  return onPathLine(w) && text === "" && w.subs.length === 1 && only !== undefined && numericOutput(only);
}
