import type { WordToken } from "./lexer.js";

/**
 * The tracked variables, as in vars.ts. Hidden `case@NAME` keys hold the case attributes NAME may carry, null
 * when they may be any; a `cased@NAME` key marks a value copied from one a case attribute may have changed.
 */
type Vars = Map<string, string | null>;

/**
 * A word holding a variable a case attribute may have changed. The mark is an own property, so a `{ ...w }`
 * copy keeps it; the value stays as written, which is what bash 3.2, having no case attributes, reads.
 */
type CaseWord = WordToken & { caseUnsure?: true };

/** A lookup whose value, null when unknown, a case attribute may have changed. */
export interface CaseUnsure {
  asWritten: string | null;
}

/** What `-l` or `-u` may change: the letters it maps, and any non-ASCII character a locale may map onto ASCII. */
const CASE_CHANGES: Record<string, RegExp> = { l: /[A-Z]|\P{ASCII}/u, u: /[a-z]|\P{ASCII}/u };

const caseKey = (name: string) => `case@${name}`;
const markKey = (name: string) => `cased@${name}`;

/** Adds the case attributes to a declared name; `+l` may remove one, which keeping it treats with the same care. */
export function markCase(vars: Vars, name: string | undefined, letters: string): void {
  if (!name) return;
  const prior = vars.has(caseKey(name)) ? (vars.get(caseKey(name)) ?? null) : "";
  vars.set(caseKey(name), prior === null ? null : prior + letters);
}

/** Marks NAME's value as copied from one a case attribute may have changed; any later write that lands clears it. */
export function markCased(vars: Vars, name: string, cased: boolean | undefined): void {
  if (cased) vars.set(markKey(name), "");
}

export function clearCased(vars: Vars, name: string): void {
  vars.delete(markKey(name));
}

export const isCased = (vars: Vars, name: string) => vars.has(markKey(name));

/**
 * Bash 5 maps a write to a `-l` or `-u` variable to that case, so a value the case may change, or an unknown
 * one, is case-unsure; so is a value copied from one.
 */
export function caseChecked(vars: Vars, name: string, value: string | null): string | null | CaseUnsure {
  if (vars.has(markKey(name))) return { asWritten: value };
  if (!vars.has(caseKey(name))) return value;
  const letters = vars.get(caseKey(name)) ?? "lu";
  const changes = value === null || [...letters].some((c) => CASE_CHANGES[c]?.test(value));
  return changes ? { asWritten: value } : value;
}

export const isCaseUnsureLookup = (found: string | null | CaseUnsure): found is CaseUnsure =>
  typeof found === "object" && found !== null;

export function markWord(w: WordToken): CaseWord {
  return { ...w, caseUnsure: true };
}

/** The word holds a variable a case attribute may have changed. */
export function isCaseUnsure(w: WordToken | null | undefined): boolean {
  return (w as CaseWord | null | undefined)?.caseUnsure === true;
}

/** The ways bash may have spelled the marked args: as written, all lower case and all upper case. */
export function caseFoldedArgs(args: WordToken[]): WordToken[][] {
  if (!args.some(isCaseUnsure)) return [args];
  const fold = (to: (v: string) => string) => args.map((a) => (isCaseUnsure(a) ? { ...a, value: to(a.value) } : a));
  return [args, fold((v) => v.toLowerCase()), fold((v) => v.toUpperCase())];
}
