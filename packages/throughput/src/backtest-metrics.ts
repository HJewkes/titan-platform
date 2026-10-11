import { type Interval, wilson } from "@titan-design/evidence/stats";
import { weightedQuantiles } from "./weighted-quantiles.js";

/** One scored test row: the realised value and the interval predicted for it. */
interface IntervalForecast {
  actual: number;
  p10: number;
  p50: number;
  p90: number;
}

interface PointForecast {
  actual: number;
  predicted: number;
}

interface Coverage {
  hits: number;
  n: number;
  /** Wilson interval on the hit rate; null when there is nothing to score. */
  rate: Interval | null;
}

/** One minute in hours, so zero-hour actuals and zero-width intervals stay finite. */
const ONE_MINUTE_HOURS = 1 / 60;
const CONTEXT_LINE_TOKENS = 150_000;

/** Share of rows whose actual lies inside [p10, p90], with a Wilson interval. */
export function intervalCoverage(rows: readonly IntervalForecast[], options: { confidence?: number } = {}): Coverage {
  const hits = rows.filter((row) => row.actual >= row.p10 && row.actual <= row.p90).length;
  const rate = rows.length === 0 ? null : wilson(hits, rows.length, options);
  return { hits, n: rows.length, rate };
}

/** Quantile (pinball) loss of one prediction at probability tau. */
export function pinballLoss(actual: number, predicted: number, tau: number): number {
  const error = actual - predicted;
  return error >= 0 ? tau * error : (tau - 1) * error;
}

/** Mean pinball loss at tau over rows; null when empty. */
export function meanPinballLoss(rows: readonly PointForecast[], tau: number): number | null {
  if (rows.length === 0) return null;
  const total = rows.reduce((sum, row) => sum + pinballLoss(row.actual, row.predicted, tau), 0);
  return total / rows.length;
}

/** Median of |ln((actual + 1m) / (predicted + 1m))|; null when empty. */
export function medianAbsLogError(rows: readonly PointForecast[]): number | null {
  const errors = rows.map((row) => Math.abs(Math.log((row.actual + ONE_MINUTE_HOURS) / (row.predicted + ONE_MINUTE_HOURS))));
  return median(errors);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.slice(Math.floor((sorted.length - 1) / 2), Math.floor(sorted.length / 2) + 1);
  return middle.reduce((sum, value) => sum + value, 0) / middle.length;
}

/** 1-based ranks, ties sharing the average of the ranks they span. */
export function averageRanks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]?.value === order[start]?.value) end += 1;
    const rank = (start + end) / 2 + 1;
    for (const { index } of order.slice(start, end + 1)) ranks[index] = rank;
    start = end + 1;
  }
  return ranks;
}

/** Spearman rank correlation; null under 3 pairs or when either side is constant. */
export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length !== ys.length) throw new RangeError(`spearman needs equal lengths, got ${xs.length} and ${ys.length}`);
  if (xs.length < 3) return null;
  return pearson(averageRanks(xs), averageRanks(ys));
}

function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const meanX = xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / ys.length;
  const dxs = xs.map((x) => x - meanX);
  const dys = ys.map((y) => y - meanY);
  const dot = (a: readonly number[], b: readonly number[]): number => a.reduce((sum, value, i) => sum + value * (b[i] ?? Number.NaN), 0);
  const covariance = dot(dxs, dys);
  const varianceX = dot(dxs, dxs);
  const varianceY = dot(dys, dys);
  if (varianceX === 0 || varianceY === 0) return null;
  return covariance / Math.sqrt(varianceX * varianceY);
}

/** A class predicts "over the line" when more than half of its training peaks were over it. */
export function predictsOverContextLine(trainPeaks: readonly number[]): boolean {
  const over = trainPeaks.filter((peak) => peak > CONTEXT_LINE_TOKENS).length;
  return over * 2 > trainPeaks.length;
}

interface ContextLineRow {
  predictedOver: boolean;
  peakContextTokens: number;
}

interface ContextLineScore {
  n: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** null when nothing was predicted over the line. */
  precision: number | null;
  /** null when nothing was actually over the line. */
  recall: number | null;
}

/** Precision and recall of the over-150k prediction; null when no row carries a peak. */
export function contextLineScore(rows: readonly ContextLineRow[]): ContextLineScore | null {
  if (rows.length === 0) return null;
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const row of rows) {
    const over = row.peakContextTokens > CONTEXT_LINE_TOKENS;
    if (row.predictedOver && over) truePositives += 1;
    else if (row.predictedOver) falsePositives += 1;
    else if (over) falseNegatives += 1;
  }
  const ratio = (hits: number, misses: number): number | null => (hits + misses === 0 ? null : hits / (hits + misses));
  return {
    n: rows.length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: ratio(truePositives, falsePositives),
    recall: ratio(truePositives, falseNegatives),
  };
}

/** The factor k that widens [p10, p90] about p50 just enough to contain the actual; 1 when inside. */
export function wideningFactor(row: IntervalForecast): number {
  // A zero-width side would need an infinite k; a one-minute floor keeps the factor usable.
  if (row.actual > row.p90) return Math.max(1, (row.actual - row.p50) / Math.max(row.p90 - row.p50, ONE_MINUTE_HOURS));
  if (row.actual < row.p10) return Math.max(1, (row.p50 - row.actual) / Math.max(row.p50 - row.p10, ONE_MINUTE_HOURS));
  return 1;
}

/** The 0.8 weighted quantile of per-row widening factors; 1 when there are no rows. */
export function conformalFactor(rows: readonly (IntervalForecast & { weight?: number })[]): number {
  if (rows.length === 0) return 1;
  return weightedQuantiles(rows.map((row) => ({ value: wideningFactor(row), weight: row.weight ?? 1 }))).p80;
}

/** [p10, p90] widened about p50 by factor k, flooring each side as wideningFactor does. */
export function widen(row: IntervalForecast, k: number): IntervalForecast {
  if (k <= 1) return row;
  const side = (width: number): number => k * Math.max(width, ONE_MINUTE_HOURS);
  return { ...row, p10: row.p50 - side(row.p50 - row.p10), p90: row.p50 + side(row.p90 - row.p50) };
}
