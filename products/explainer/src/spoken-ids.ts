import type { L0Check, L0Result } from "./eval-l0.js";
import { spokenText } from "./lint-register.js";
import { countRow } from "./lint-text.js";
import { namedBeats } from "./repair-hint.js";
import type { ScriptBeat, ScriptV1 } from "./script-schema.js";
import { numberForms, termSpellings } from "./spoken-numbers.js";

/**
 * A daily never says a pull request, task or internal script id aloud (owner decision, TP-4697 and TP-3864): the id
 * goes on screen and in fact_ids, and the line names the change by what it did. These are the id mentions a line holds,
 * in digits or spelled the way the speller reads them.
 */
export interface IdMention {
  index: number;
  text: string;
  /** What the mention names, whatever its spelling: a number's value ("6420") or a script id's own text ("F7"). */
  key: string;
}

type IdBeat = Pick<ScriptBeat, "spoken" | "fact_ids" | "new_terms">;

const WORD =
  "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)";
const NUMERAL = `(?:\\d+(?:,\\d{3})*|${WORD}(?:[\\s-]+${WORD})*)(?![\\p{L}\\p{N}])`;
const LEAD = "(?:PRs?|pull requests?|tickets?|TP)";
const NEXT = `(?:,\\s*|,?\\s+(?:and|or)\\s+)(?:#\\s*)?${NUMERAL}`;
// "Tickets one of which" counts, it names no ticket.
const LEAD_ID = new RegExp(`(?<![\\p{L}\\p{N}])(?:${LEAD}(?:\\s*#\\s*|\\s+|-)|#)${NUMERAL}(?![\\s-]+of\\b)(?:${NEXT})*`, "giu");
const TASK_ID = /(?<![\p{L}\p{N}-])\p{Lu}{2,5}-\d{3,}(?![\p{L}\p{N}])/gu;
// Fact, map and item ids a script plans with: F7, M0-M10, I1, Q-V12, g10-adversary.
const SCRIPT_ID = /(?<![\p{L}\p{N}-])(?:(?:\p{Lu}+-)*\p{Lu}{1,2}\d{1,3}(?:-\p{Lu}{1,2}\d{1,3})?|\p{Ll}{1,3}\d{1,3}(?:-\p{Ll}+)+)(?![\p{L}\p{N}-])/gu;
const MIN_CITED_DIGITS = 3;

const norm = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The value a numbered mention names: its first number, so "TP seventy oh one" is 7001 and "TP seventy" is 70. */
function numberKey(text: string): string {
  const numeral = text.replace(new RegExp(`^(?:${LEAD}(?:\\s*#\\s*|\\s+|-)|#)`, "iu"), "").split(/,|\s(?:and|or)\s/i)[0] ?? "";
  return numberForms(numeral)[0] ?? norm(numeral);
}

const matches = (text: string, pattern: RegExp, key: (found: string) => string): IdMention[] =>
  [...text.matchAll(pattern)].map((m) => ({ index: m.index, text: m[0], key: key(m[0]) }));

/** A spelling of a numbered term the beat cites, said bare: "then sixty-four twenty turned it on". */
function citedMentions(text: string, beat: IdBeat): IdMention[] {
  const terms = [...beat.fact_ids, ...beat.new_terms];
  return terms.flatMap((term) => {
    const [digits, ...spellings] = termSpellings(term);
    if (digits === undefined || digits.length < MIN_CITED_DIGITS) return [];
    return [digits, ...spellings].flatMap((form) =>
      matches(text, new RegExp(`(?<![\\p{L}\\p{N}-])${escapeRegExp(form)}(?![\\p{L}\\p{N}]|-\\p{L})`, "giu"), () => digits),
    );
  });
}

/** A cited fact id with a digit in it, said as written. */
const citedIds = (text: string, beat: IdBeat): IdMention[] =>
  beat.fact_ids
    .filter((id) => /\d/.test(id) && !id.includes("/"))
    .flatMap((id) => matches(text, new RegExp(`(?<![\\p{L}\\p{N}-])${escapeRegExp(id)}(?![\\p{L}\\p{N}])`, "giu"), () => id.toUpperCase()));

/** Overlapping mentions kept once, the earliest and longest first. */
function distinct(mentions: readonly IdMention[]): IdMention[] {
  const ordered = [...mentions].sort((a, b) => a.index - b.index || b.text.length - a.text.length);
  const kept: IdMention[] = [];
  for (const mention of ordered) {
    const last = kept.at(-1);
    if (!last || mention.index >= last.index + last.text.length) kept.push(mention);
  }
  return kept;
}

/** Every id mention in a beat's spoken line, with markup reduced to the words it says. */
export function spokenIds(beat: IdBeat): IdMention[] {
  const text = spokenText([beat.spoken]).text;
  return distinct([
    ...matches(text, LEAD_ID, numberKey),
    ...matches(text, TASK_ID, (found) => found.replace(/^\p{Lu}+-/u, "")),
    ...matches(text, SCRIPT_ID, (found) => found.toUpperCase()),
    ...citedMentions(text, beat),
    ...citedIds(text, beat),
  ]);
}

/** Whether a declared term or fact id names an item by id, not by a word a line would say. */
export const isIdTerm = (term: string): boolean =>
  termSpellings(term).length > 0 || new RegExp(`^(?:${SCRIPT_ID.source})$`, "u").test(term.trim()) || new RegExp(`^(?:${TASK_ID.source})$`, "u").test(term.trim());

/** Q-V15: no spoken line says a PR, task or script id. */
export const spokenIdsCheck: L0Check = ({ script }) => [countRow("Q-V15", script.beats.filter((beat) => spokenIds(beat).length > 0).map((beat) => beat.id))];

/** The Q-V15 repair: each id a line says, and where the id goes instead. */
export function spokenIdsHint(script: ScriptV1, row: L0Result): string {
  const named = namedBeats(script, row).map((beat) => `${beat.id} ${spokenIds(beat).map((id) => `"${id.text}"`).join(", ")}`);
  return `ids said aloud: ${named.join("; ")}. Name each pull request, task or item by what it did ("the guard fix"), never by its number or id; the id stays on screen, in a label, chip or the headline, and in fact_ids`;
}
