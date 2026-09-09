import type { DecayedCounts, FeedbackEvent, Maturity } from "./types.js";

/** cass-memory's exact numbers; a bullet may override the half-life, nothing else. */
export const DEFAULT_HALF_LIFE_DAYS = 90;
export const HARMFUL_WEIGHT = 4;
export const HARD_DEPRECATE_SCORE = -3;
export const MATURITY_MULTIPLIER: Record<Maturity, number> = { candidate: 0.5, established: 1, proven: 1.5, deprecated: 0 };

const RANK: Record<Maturity, number> = { deprecated: 0, candidate: 1, established: 2, proven: 3 };
const BY_RANK: Maturity[] = ["deprecated", "candidate", "established", "proven"];
const DAY_MS = 86_400_000;

export function decayedValue(at: string, now: Date, halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS): number {
  const ageDays = Math.max(0, now.getTime() - Date.parse(at)) / DAY_MS;
  return 0.5 ** (ageDays / halfLifeDays);
}

export function decayedCounts(events: readonly FeedbackEvent[], now: Date, halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS): DecayedCounts {
  const counts = { helpful: 0, harmful: 0 };
  for (const event of events) counts[event.type] += decayedValue(event.at, now, halfLifeDays);
  return counts;
}

export function effectiveScore(counts: DecayedCounts, maturity: Maturity): number {
  return (counts.helpful - HARMFUL_WEIGHT * counts.harmful) * MATURITY_MULTIPLIER[maturity];
}

/** The maturity the decayed counts alone would assign, ignoring history. */
export function maturityFor(counts: DecayedCounts): Maturity {
  const total = counts.helpful + counts.harmful;
  const harmfulRatio = total === 0 ? 0 : counts.harmful / total;
  if (total < 3) return "candidate";
  if (harmfulRatio > 0.3) return "deprecated";
  if (counts.helpful >= 10 && harmfulRatio < 0.1) return "proven";
  return "established";
}

/**
 * Promotion jumps straight to the earned rung; demotion drops one rung per
 * pass, except that a score below the hard floor deprecates outright. Pinned
 * bullets never move.
 */
export function nextMaturity(current: Maturity, counts: DecayedCounts, pinned: boolean): Maturity {
  if (pinned || current === "deprecated") return current;
  if (effectiveScore(counts, current) < HARD_DEPRECATE_SCORE) return "deprecated";
  const target = maturityFor(counts);
  if (RANK[target] > RANK[current]) return target;
  if (RANK[target] < RANK[current]) return BY_RANK[RANK[current] - 1]!;
  return current;
}

export interface StalenessOptions {
  /** Days without any feedback before a bullet is flagged for re-validation. */
  staleAfterDays?: number;
}

/** Staleness is about silence, not decay: a bullet nobody has confirmed or refuted lately. */
export function isStale(lastEvidenceAt: string, now: Date, { staleAfterDays = 180 }: StalenessOptions = {}): boolean {
  return now.getTime() - Date.parse(lastEvidenceAt) > staleAfterDays * DAY_MS;
}
