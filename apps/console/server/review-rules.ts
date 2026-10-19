/**
 * The Reviews tab's policy as data: which files a review folder holds, how its label is read,
 * and the rule table that derives a review's state from the artifacts present. `reviews.ts`
 * only reads and applies it. The README's own status line is never an input: it is often stale.
 */

/** The artifact files read per review, at fixed paths; the root is never walked. */
export const REVIEW_FILES = {
  readme: "README.md",
  summary: "SUMMARY.md",
  runs: "runs.tsv",
  label: "synthesis/current-label",
} as const;

export const SYNTHESIS_DIR = "synthesis";
export const TOPICS_FILE = "topics-judged.tsv";
export const CLAIMS_FILE = "claims-audit.tsv";

/** A review is a direct child of the reviews dir with this name; anything else is skipped. */
export const REVIEW_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** A label names a dir under `synthesis/`, so it can never hold a dot or a slash. */
export const REVIEW_LABEL = /^[a-z0-9-]+$/;
/** What the list calls a review whose TSVs sit directly in `synthesis/`, with no current-label file. */
export const FLAT_LABEL = "flat";
const FINAL_LABEL = "final";
/** The marker a harvest in progress leaves in the review root. */
export const WAVE_STATE = /^wave\d+-state\.json$/;
/** The priorities the list counts. */
export const COUNTED_PRIORITIES = ["P1", "P2"] as const;

export const REVIEW_STATES = ["pinned", "skimmed", "reading", "summarized", "final"] as const;
type ReviewState = (typeof REVIEW_STATES)[number];

/** What the rule table sees of one review. */
interface ReviewFacts {
  label: string | null;
  hasClaims: boolean;
  hasWaveState: boolean;
  hasSummary: boolean;
  /** The SUMMARY's coverage `unread=N`, or null when it has no such line. */
  unread: number | null;
}

/** The first rule that holds wins, so the furthest state comes first; `pinned` needs only a README. */
const STATE_RULES: readonly { state: ReviewState; when: (facts: ReviewFacts) => boolean }[] = [
  { state: "final", when: (facts) => facts.hasSummary && facts.label === FINAL_LABEL && facts.unread === 0 },
  { state: "summarized", when: (facts) => facts.hasSummary },
  { state: "reading", when: (facts) => facts.hasWaveState },
  { state: "skimmed", when: (facts) => facts.hasClaims },
  { state: "pinned", when: () => true },
];

export function reviewState(facts: ReviewFacts): ReviewState {
  return STATE_RULES.find((rule) => rule.when(facts))?.state ?? "pinned";
}

/** The coverage line, a bullet or a table row naming coverage and `unread=N`; null when the SUMMARY has none. */
export function coverageOf(summary: string): { line: string; unread: number } | null {
  for (const line of summary.split(/\r?\n/)) {
    const unread = /(?<![\w-])unread=(\d+)(?!\w)/.exec(line);
    if (unread !== null && /coverage/i.test(line)) return { line: line.trim(), unread: Number(unread[1]) };
  }
  return null;
}
