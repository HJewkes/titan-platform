import type { Labels } from "./eval-calibrate.js";
import type { ColdGrade, ColdResult, ColdScore } from "./eval-cold.js";
import { termKey } from "./eval-cold-terms.js";
import { mentions } from "./lexicon.js";

type ReaderGapGroup = Labels["items"][number];

export interface ReaderGapScore {
  group: string;
  /** The questions the group is scored on: each item's first, or its first-use beats' when no item is asked. */
  asked: string[];
  /** The lowest of those scores, so one unexplained item is a gap found; null when nothing was asked. */
  score: 0 | 1 | 2 | null;
}

// The term's own question wins over a longer label that carries it: "I2 verdict at head" asks about the invariant.
const firstAsking = (scores: readonly ColdScore[], item: string): ColdScore | undefined =>
  scores.find((s) => termKey(s.item) === termKey(item)) ?? scores.find((s) => mentions(termKey(s.item), termKey(item)));

/**
 * One run's score for each labelled reader-gap group, at the item's first question as `spokenTerms` places it. A
 * group that names a whole list ("the seven jobs") matches no question by its words, so its first-use beats' do.
 */
export function readerGapScores(groups: readonly ReaderGapGroup[], result: ColdResult): ReaderGapScore[] {
  const scores = result.chapters.flatMap((c) => c.scores);
  return groups.map(({ group, items, first_used }) => {
    const firsts = items.flatMap((item) => firstAsking(scores, item) ?? []);
    const asked = firsts.length > 0 ? firsts : scores.filter((s) => first_used.includes(s.beat));
    const lowest = asked.length > 0 ? asked.reduce<ColdGrade["score"]>((low, s) => (s.score < low ? s.score : low), 2) : null;
    return { group, asked: asked.map((s) => s.item), score: lowest };
  });
}
