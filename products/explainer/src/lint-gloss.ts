import { contentTerms } from "./lint-text.js";
import type { PaceBeat, PaceItem } from "./pace-items.js";

/** M3-pre: a beat must put at least this many new items on screen before it can be routed. */
const MIN_NEW_ITEMS = 3;

/** M3-pre: an item glossed by fewer content words than this, in its own clause, is named only. */
const MIN_GLOSS_TERMS = 3;

/** M3-pre: a beat whose items average a gloss below this is routed. */
const MAX_MEAN_GLOSS = 1;

// The colon split is what script-method's splitter did: it cut "Ten: the ledger" at "Ten:".
const CLAUSE_BREAK = /[.?!;:,]|\band\b|\bor\b/i;

// Function words a standard English stopword list drops but contentTerms keeps. They explain nothing, yet counting
// them ("an audit of our own engine") lifts a named-only beat's mean gloss to the threshold.
const FILLER = new Set(
  (
    "myself ours ourselves yours yourself him himself hers herself itself themselves being having doing because " +
    "until while against between through during above below down out off again further once both few other such " +
    "nor own same too"
  )
    .split(" ")
    .flatMap((w) => [...contentTerms(w)]),
);

// Number words a standard English stopword list keeps but contentTerms drops. Folded to digits, so "five" in
// "the five-hour ceiling" restates a "5-hour" label, while "Four" in "Four wakes fixers" and "Ten" in "Ten: two pool
// rules" are words the clause adds.
const NUMBER_WORDS = new Map(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].map((w, i) => [w, String(i + 1)]));

const numberOf = (word: string): string[] => {
  const spelled = NUMBER_WORDS.get(word);
  if (spelled) return [spelled];
  return /^\d+$/.test(word) ? [word] : [];
};

/** Content terms, plus spelled numbers and bare digit runs, both as digits. */
const glossTerms = (text: string): Set<string> =>
  new Set([...contentTerms(text), ...text.toLowerCase().split(/[^a-z0-9]+/).flatMap(numberOf)]);

/** The clauses of a spoken line: split at punctuation and at "and" and "or". */
export const clausesOf = (spoken: string): string[] =>
  spoken
    .split(CLAUSE_BREAK)
    .map((c) => c.trim())
    .filter(Boolean);

const cueKey = (word: string): string => word.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, "");

/** The clause the cue ("word" or "word#n") is spoken in, matched as the cue resolver matches it. */
function cueClause(cue: string, clauses: readonly string[]): string | undefined {
  const [word = "", nth = "1"] = cue.split("#");
  const owners = clauses.flatMap((clause) => clause.split(/\s+/).filter((w) => cueKey(w) === cueKey(word)).map(() => clause));
  return owners[Number(nth) - 1];
}

/**
 * An item's own clause is the one its cue word is spoken in, which is where it lands on screen. A cue several
 * items share marks a group ("Eight follow-ups"), so each of them falls back to the first clause naming it.
 */
function ownClause(item: PaceItem, clauses: readonly string[], shared: ReadonlySet<string>): string | undefined {
  const cued = item.cue !== undefined && !shared.has(item.cue) ? cueClause(item.cue, clauses) : undefined;
  const own = glossTerms(item.label);
  return cued ?? clauses.find((c) => [...glossTerms(c)].some((t) => own.has(t)));
}

/** Words that gloss an item: those of its own clause, less the beat's own label terms, so naming a sibling is not a gloss. */
export function itemGloss(clause: string | undefined, labelTerms: ReadonlySet<string>): number {
  return clause === undefined ? 0 : [...glossTerms(clause)].filter((t) => !labelTerms.has(t) && !FILLER.has(t)).length;
}

const sharedCues = (items: readonly PaceItem[]): Set<string> => {
  const cues = items.flatMap((i) => (i.cue === undefined ? [] : [i.cue]));
  return new Set(cues.filter((c, i) => cues.indexOf(c) !== i));
};

/** One beat the L1 item judge (TP-2982) asks "is each of these explained?" about, with the items it names only. */
export interface ExplainRoute {
  beat: string;
  items: string[];
}

const spokenLater = (beats: readonly PaceBeat[], index: number, chapter: string): Set<string> => {
  const later = beats.slice(index + 1).filter((b) => b.chapter === chapter);
  return new Set(later.flatMap((b) => [...contentTerms(b.spoken)]));
};

// A label with no content terms (a "why" pin) has nothing to find in a clause or a later beat, so it is left out
// of the count rather than scored as named only or as explained.
const measurable = (beat: PaceBeat): PaceItem[] => beat.newItems.filter((i) => contentTerms(i.label).size > 0);

/** Each measurable new item's own clause, keyed by label, read as the route reads it. */
export function itemClauses(beat: PaceBeat): Map<string, string | undefined> {
  const items = measurable(beat);
  const clauses = clausesOf(beat.spoken);
  const shared = sharedCues(items);
  return new Map(items.map((i) => [i.label, ownClause(i, clauses, shared)]));
}

function beatRoute(beats: readonly PaceBeat[], beat: PaceBeat, index: number): ExplainRoute | undefined {
  const items = measurable(beat);
  if (items.length < MIN_NEW_ITEMS) return undefined;
  const clauses = clausesOf(beat.spoken);
  const labelTerms = new Set(items.flatMap((i) => [...glossTerms(i.label)]));
  const shared = sharedCues(items);
  const later = spokenLater(beats, index, beat.chapter);
  const glossed = items.map((i) => ({ label: i.label, gloss: itemGloss(ownClause(i, clauses, shared), labelTerms) }));
  const namedOnly = glossed.filter(({ label, gloss }) => gloss < MIN_GLOSS_TERMS && ![...contentTerms(label)].every((t) => later.has(t)));
  const meanGloss = glossed.reduce((sum, g) => sum + g.gloss, 0) / glossed.length;
  const routed = namedOnly.length * 2 >= glossed.length && meanGloss < MAX_MEAN_GLOSS;
  return routed ? { beat: beat.id, items: namedOnly.map((g) => g.label) } : undefined;
}

/**
 * M3-pre (script-method section 3b): beats that name three or more new items, at least half of them named only
 * (barely glossed in their own clause and not spoken again later in the chapter), with a mean gloss under one word.
 * A heuristic prefilter for the L1 item judge, about half false positives; it never gates.
 */
export function explainRoutes(beats: readonly PaceBeat[]): ExplainRoute[] {
  return beats.flatMap((beat, i) => beatRoute(beats, beat, i) ?? []);
}
