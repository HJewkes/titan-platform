import { contentTerms } from "./lint-text.js";
import type { PaceBeat } from "./pace-items.js";

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

/** The clauses of a spoken line: split at punctuation and at "and" and "or". */
const clausesOf =(spoken: string): string[] =>
  spoken
    .split(CLAUSE_BREAK)
    .map((c) => c.trim())
    .filter(Boolean);

/**
 * Content words that gloss an item: those of the first clause sharing a content term with its label, less the
 * beat's own label terms, so naming a sibling item is not a gloss. Zero when no clause names the item.
 */
function itemGloss(label: string, clauses: readonly string[], labelTerms: ReadonlySet<string>): number {
  const own = contentTerms(label);
  const clause = clauses.map(contentTerms).find((terms) => [...terms].some((t) => own.has(t)));
  return clause ? [...clause].filter((t) => !labelTerms.has(t) && !FILLER.has(t)).length : 0;
}

/** One beat the L1 item judge (TP-2982) asks "is each of these explained?" about, with the items it names only. */
interface ExplainRoute {
  beat: string;
  items: string[];
}

const spokenLater = (beats: readonly PaceBeat[], index: number): Set<string> => {
  const { chapter } = beats[index];
  const later = beats.slice(index + 1).filter((b) => b.chapter === chapter);
  return new Set(later.flatMap((b) => [...contentTerms(b.spoken)]));
};

// A label with no content terms (a "why" pin) has nothing to find in a clause or a later beat, so it is left out
// of the count rather than scored as named only or as explained.
const measurable = (beat: PaceBeat): string[] => beat.newItems.map((i) => i.label).filter((l) => contentTerms(l).size > 0);

function beatRoute(beats: readonly PaceBeat[], index: number): ExplainRoute | undefined {
  const labels = measurable(beats[index]);
  if (labels.length < MIN_NEW_ITEMS) return undefined;
  const clauses = clausesOf(beats[index].spoken);
  const labelTerms = new Set(labels.flatMap((l) => [...contentTerms(l)]));
  const later = spokenLater(beats, index);
  const glossed = labels.map((label) => ({ label, gloss: itemGloss(label, clauses, labelTerms) }));
  const namedOnly = glossed.filter(({ label, gloss }) => gloss < MIN_GLOSS_TERMS && ![...contentTerms(label)].every((t) => later.has(t)));
  const meanGloss = glossed.reduce((sum, g) => sum + g.gloss, 0) / glossed.length;
  const routed = namedOnly.length * 2 >= glossed.length && meanGloss < MAX_MEAN_GLOSS;
  return routed ? { beat: beats[index].id, items: namedOnly.map((g) => g.label) } : undefined;
}

/**
 * M3-pre (script-method section 3b): beats that name three or more new items, at least half of them named only
 * (barely glossed in their own clause and not spoken again later in the chapter), with a mean gloss under one word.
 * A heuristic prefilter for the L1 item judge, about half false positives; it never gates.
 */
export function explainRoutes(beats: readonly PaceBeat[]): ExplainRoute[] {
  return beats.flatMap((_, i) => beatRoute(beats, i) ?? []);
}
