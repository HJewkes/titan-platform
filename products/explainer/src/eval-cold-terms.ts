import { mentions, spelledAs } from "./lexicon.js";
import { clausesOf, itemGloss } from "./lint-gloss.js";
import { contentTerms, sharesTerm } from "./lint-text.js";
import type { PaceBeat } from "./pace-items.js";

export const listedLabels = (beat: PaceBeat): string[] => beat.items.filter((i) => i.role === "item").map((i) => i.label);

// Bare means spoken and never glossed by a single word. M3-pre's three-word bar is a router's bar: here it would
// void "two adds the review queue" too, an item the viewer can explain. An item never spoken is left to the judge.
function isBare(label: string, clauses: readonly string[], labelTerms: ReadonlySet<string>): boolean {
  const naming = clauses.filter((clause) => sharesTerm(clause, label));
  return naming.length > 0 && naming.every((clause) => itemGloss(clause, labelTerms) === 0);
}

/**
 * The bare items of each roll call in a chapter, keyed `beat\0label`: a list beat (at least `minItems` long) whose
 * items are at least half bare, as M3-pre counts a beat named only when half its items are. One bare item among
 * glossed siblings is left to the judge, since the siblings' gloss may cover it.
 */
export function bareListItems(chapter: readonly PaceBeat[], minItems: number): Set<string> {
  const clauses = chapter.flatMap((b) => clausesOf(b.spoken));
  return new Set(
    chapter.flatMap((beat) => {
      const listed = listedLabels(beat);
      if (listed.length < minItems) return [];
      const labelTerms = new Set(listed.flatMap((l) => [...contentTerms(l)]));
      const bare = listed.filter((l) => isBare(l, clauses, labelTerms));
      return bare.length * 2 >= listed.length ? bare.map((label) => bareKey(beat.id, label)) : [];
    }),
  );
}

export const bareKey = (beat: string, label: string): string => `${beat}\0${label}`;

// A project's own identifier (F7, M3, Q10): its shape alone says that only this project can define it, so it is
// asked without being declared. Plain words ("head", "grant") can be jargon too, but nothing in their spelling says
// so; only the script's glossary, or cold viewers who name them (`agreedTerms`), can.
const IDENTIFIER = /\b[A-Z]{1,2}\d+\b/g;

/** One term the viewer hears before any label shows it: the beat that first speaks it, and the term as written. */
interface SpokenTerm {
  beat: string;
  term: string;
}

// Only a new item's label that is the term itself counts. An attribute ("after the F7 eval") is shown but never asked,
// and a longer label ("I2 verdict at head") is asked about as a whole, so a term inside either would go unasked.
const askedBy = (beat: PaceBeat, term: string): boolean => beat.newItems.some((i) => termKey(i.label) === termKey(term));

// Only the last word is folded: "carry modules" and "carry module" are one term, "class" and "status" stay whole.
function singular(word: string): string {
  if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:ss|sh|ch|x|z)es$/.test(word)) return word.slice(0, -2);
  return /[^siu]s$/.test(word) && word.length > 3 ? word.slice(0, -1) : word;
}

/** A named term with case and plural folded, so "Heads" and "head" are one vote. */
export function termKey(term: string): string {
  const words = term.trim().toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  const last = words.pop();
  return last === undefined ? "" : [...words, singular(last)].join(" ");
}

// The asked form is spelled as the narration first speaks it, since a term is placed at its first spoken beat by
// whole-term match and a viewer's "CHIPS" or "chip" would not read as the "chips" it heard.
function firstSpokenForm(beats: readonly PaceBeat[], forms: readonly string[]): string | null {
  const firstUse = (form: string) => beats.findIndex((b) => mentions(b.spoken, form));
  const [first] = forms.map((form) => ({ form, at: firstUse(form) })).filter((f) => f.at >= 0).sort((a, b) => a.at - b.at);
  return first ? spelledAs(beats[first.at]!.spoken, first.form) : null;
}

/**
 * The terms at least `quorum` viewer runs named as undefined, folded by `termKey` and counted once a run, each in
 * the form the narration speaks first. One run's list is noise: a viewer names a word in one run and not the next.
 * A term the narration never speaks is dropped.
 */
export function agreedTerms(runs: readonly (readonly string[])[], beats: readonly PaceBeat[], quorum: number): string[] {
  const named = new Map<string, { runs: Set<number>; forms: Set<string> }>();
  runs.forEach((terms, run) => {
    for (const term of terms) {
      const key = termKey(term);
      if (key === "") continue;
      const entry = named.get(key) ?? { runs: new Set(), forms: new Set() };
      named.set(key, { runs: entry.runs.add(run), forms: entry.forms.add(term.trim()) });
    }
  });
  return [...named].flatMap(([key, { runs: voters, forms }]) => {
    const form = voters.size >= quorum ? firstSpokenForm(beats, [...forms, key, `${key}s`, `${key}es`]) : null;
    return form === null ? [] : [form];
  });
}

/**
 * Spoken terms not defined on screen: each glossary term and each identifier, at the first beat that speaks it,
 * unless a new item's label at or before that beat names it, since the item track asks that one. Video-wide, so a
 * term first spoken in an earlier chapter is not asked again.
 */
export function spokenTerms(beats: readonly PaceBeat[], glossary: readonly string[] = []): SpokenTerm[] {
  const spokenIds = beats.flatMap((b) => [...b.spoken.matchAll(IDENTIFIER)].map((m) => m[0]));
  const candidates = [...new Map([...glossary, ...spokenIds].map((t) => [t.trim().toLowerCase(), t.trim()])).values()];
  return candidates.flatMap((term) => {
    const first = beats.findIndex((b) => mentions(b.spoken, term));
    const asked = beats.slice(0, first + 1).some((b) => askedBy(b, term));
    return first < 0 || asked ? [] : [{ beat: beats[first]!.id, term }];
  });
}
