import type { WordToken } from "./lexer.js";

/** The tracked variables, as in vars.ts; hidden `case@NAME` keys hold the case attributes NAME may carry. */
type Vars = Map<string, string | null>;

/** What `-l` or `-u` may change: the letters it maps, and any non-ASCII character a locale may map onto ASCII. */
const CASE_CHANGES: Record<string, RegExp> = { l: /[A-Z]|\P{ASCII}/u, u: /[a-z]|\P{ASCII}/u };

/** A lookup of a variable that is unknown and may carry a case attribute, which may have changed what it held. */
export const CASE_UNSURE = Symbol("case-unsure");

/** Words left unexpanded because a variable in them is {@link CASE_UNSURE}. */
const caseUnsureWords = new WeakSet<WordToken>();

const caseKey = (name: string) => `case@${name}`;

/**
 * Bash 5 maps a write to a `-l` or `-u` variable to that case and bash 3.2 has no such attribute, so a value
 * is known only when the case it may carry leaves it as written, whether or not the declaration surely ran.
 */
export function cased(vars: Vars, name: string, value: string | null): string | null {
  if (value === null || !vars.has(caseKey(name))) return value;
  const letters = vars.get(caseKey(name)) ?? "lu";
  return [...letters].some((c) => CASE_CHANGES[c]?.test(value)) ? null : value;
}

/** Adds the case attributes to a declared name; `+l` may remove one, which keeping it treats with the same care. */
export function markCase(vars: Vars, name: string | undefined, letters: string): void {
  if (!name) return;
  const prior = vars.has(caseKey(name)) ? (vars.get(caseKey(name)) ?? null) : "";
  vars.set(caseKey(name), prior === null ? null : prior + letters);
}

/** An unknown value of a variable that may carry a case attribute reads as {@link CASE_UNSURE}. */
export function caseChecked(vars: Vars, name: string, value: string | null): string | null | typeof CASE_UNSURE {
  return value === null && vars.has(caseKey(name)) ? CASE_UNSURE : value;
}

export function noteCaseUnsure(w: WordToken): void {
  caseUnsureWords.add(w);
}

/** The word holds a variable a case attribute may have changed, so a push to it may reach any branch. */
export function isCaseUnsure(w: WordToken): boolean {
  return caseUnsureWords.has(w);
}
