import { bootstrapCI, mcnemar, minimumDetectableEffect, pairedBootstrap, wilson } from "@titan-design/evidence/stats";

/** Every bootstrap seed derives from this, so a rerun over the same ledgers prints the same intervals. */
const SEED = "bench-report-2026-11";
const RESAMPLES = 10_000;
const ALPHA = 0.05;
/** Section 3.3 plans MDEs at discordance 0.25, a per-case difference sd of 0.5; an observed sd below it would flatter the MDE. */
const PLANNING_DIFF_SD = 0.5;

export interface RateCell {
  successes: number;
  n: number;
  rate: number;
  lower: number;
  upper: number;
}

export interface Range {
  estimate: number | null;
  lower: number | null;
  upper: number | null;
}

export function rateOf(values: readonly (number | null)[]): RateCell | null {
  const scored = values.filter((value): value is number => value !== null);
  if (scored.length === 0) return null;
  const successes = scored.filter((value) => value === 1).length;
  const interval = wilson(successes, scored.length);
  return { successes, n: scored.length, rate: interval.estimate, lower: interval.lower, upper: interval.upper };
}

/** Linear interpolation between order statistics; null for no values. */
export function quantile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const below = Math.floor(position);
  const low = sorted[below] ?? 0;
  const high = sorted[Math.min(below + 1, sorted.length - 1)] ?? low;
  return low + (high - low) * (position - below);
}

export const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

const finite = (value: number): number | null => (Number.isFinite(value) ? value : null);

/** Total $ over successes, with a bootstrap that resamples cases; a resample with no success has no ratio and reads as unbounded. */
export function costPerSuccess(costs: readonly number[], successes: readonly number[], label: string): Range {
  const total = (indices: readonly number[]): number => {
    const won = indices.reduce((sum, i) => sum + (successes[i] ?? 0), 0);
    return won === 0 ? Number.POSITIVE_INFINITY : indices.reduce((sum, i) => sum + (costs[i] ?? 0), 0) / won;
  };
  if (costs.length === 0) return { estimate: null, lower: null, upper: null };
  const indices = costs.map((_, i) => i);
  const { estimate, lower, upper } = bootstrapCI(indices, { resamples: RESAMPLES, seed: `${SEED}:cost:${label}`, statistic: total });
  return { estimate: finite(estimate), lower: finite(lower), upper: finite(upper) };
}

export interface PairedDiff {
  n: number;
  delta: number;
  lower: number;
  upper: number;
  /** Cases where the arm scored above production, and below it: McNemar's discordant pairs (a sign test for P). */
  armAhead: number;
  productionAhead: number;
  p: number;
}

/** arm minus production per case, paired-bootstrap CI and exact McNemar on the discordant pairs. */
export function pairedDiff(arm: readonly number[], production: readonly number[], label: string): PairedDiff | null {
  if (arm.length === 0) return null;
  const ci = pairedBootstrap(arm, production, { resamples: RESAMPLES, seed: `${SEED}:pair:${label}` });
  const armAhead = arm.filter((value, i) => value > (production[i] ?? value)).length;
  const productionAhead = arm.filter((value, i) => value < (production[i] ?? value)).length;
  const { pValue } = mcnemar(armAhead, productionAhead, { method: "exact" });
  return { n: arm.length, delta: ci.estimate, lower: ci.lower, upper: ci.upper, armAhead, productionAhead, p: pValue };
}

/** Holm step-down adjusted p-values, in the input order. */
export function holm(pValues: readonly number[]): number[] {
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(pValues.length);
  let running = 0;
  order.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, (pValues.length - rank) * p));
    adjusted[i] = running;
  });
  return adjusted;
}

export const significant = (pHolm: number): boolean => pHolm < ALPHA;

/** The difference a paired test at this n would detect with power 0.8, using the larger of the observed and planning sd. */
export function mde(arm: readonly number[], production: readonly number[]): number | null {
  if (arm.length < 2) return null;
  const diffs = arm.map((value, i) => value - (production[i] ?? value));
  const centre = mean(diffs) ?? 0;
  const observed = Math.sqrt(diffs.reduce((sum, d) => sum + (d - centre) ** 2, 0) / (diffs.length - 1));
  return minimumDetectableEffect({ n: arm.length, sd: Math.max(observed, PLANNING_DIFF_SD) });
}
