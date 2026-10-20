import { mentions } from "./lexicon.js";
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
// so; only the script's glossary can.
const IDENTIFIER = /\b[A-Z]{1,2}\d+\b/g;

/** One term the viewer hears before any label shows it: the beat that first speaks it, and the term as written. */
interface SpokenTerm {
  beat: string;
  term: string;
}

// Only a new item's label counts: the item track asks about those, while an attribute ("after the F7 eval") is shown
// but never asked, so a term it carries would go unasked.
const askedBy = (beat: PaceBeat, term: string): boolean => beat.newItems.some((i) => mentions(i.label, term));

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
