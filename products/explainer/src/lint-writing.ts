import { REGISTER_BANDS, REGISTER_MEASURES, REGISTER_METRICS, sentenceLengths, type Band, type SpokenText } from "./lint-register.js";

const MIN_SENTENCES = 3;

/**
 * Local burstiness: the mean step between neighbouring sentence lengths, over the mean sentence length. Undefined on
 * unpunctuated text and under 3 sentences. Machine text runs flatter, so low is the tell (TP-4662 S0).
 */
export function adjacentDelta(s: SpokenText): number | undefined {
  const lengths = sentenceLengths(s);
  if (!s.punctuated || lengths.length < MIN_SENTENCES) return undefined;
  const total = lengths.reduce((sum, n) => sum + n, 0);
  const steps = lengths.slice(1).reduce((sum, n, i) => sum + Math.abs(n - (lengths[i] ?? n)), 0);
  return steps / (lengths.length - 1) / (total / lengths.length);
}

/** The writing check's rows: the register rows plus those that measure a script without warning the L0 register check. */
export const WRITING_METRICS = [...REGISTER_METRICS, "adjacent-delta"] as const;
export type WritingMetric = (typeof WRITING_METRICS)[number];

export const WRITING_MEASURES: Record<WritingMetric, (s: SpokenText) => number | undefined> = { ...REGISTER_MEASURES, "adjacent-delta": adjacentDelta };

/** Rows where only the low side is a tell. Their `max` is the measure's own ceiling, so it never flags. */
export const FLOOR_ONLY_METRICS: ReadonlySet<WritingMetric> = new Set(["adjacent-delta"]);

/**
 * `adjacent-delta`'s floor is the human-creator per-script P25 (0.5548), the method behind the register bands and fitted
 * without held-out text. Its ceiling is 2n/(n-1) at n = 3 sentences, the highest the measure can reach.
 */
export const WRITING_BANDS: Record<WritingMetric, Band> = { ...REGISTER_BANDS, "adjacent-delta": { min: 0.55, max: 3 } };
