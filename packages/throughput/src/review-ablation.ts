import { intervalCoverage, meanPinballLoss } from "./backtest-metrics.js";
import { type ThroughputConfig } from "./class-table.js";
import { perTarget, REVIEW_TARGETS, reviewFeatureKey, reviewFor, reviewTable, reviewTarget, type ReviewKey, type ReviewTable, type ReviewTarget } from "./review-model.js";
import { isEligible, type ThroughputRow } from "./rows.js";
import { type Quantiles } from "./weighted-quantiles.js";

const MS_PER_DAY = 86_400_000;
const DEFAULT_HORIZON_DAYS = 7;
/** Below this many scored rows a target's comparison is reported as insufficient, not a win or loss. */
export const MIN_ABLATION_N = 40;
const ARMS: readonly ReviewKey[] = ["diff", "base"];

export interface ReviewAblationOptions {
  /** ISO dates; each one refits both arms on rows done before it. */
  origins: readonly string[];
  horizonDays?: number;
  /** Passed to reviewTable for both arms; `asOf` is always the origin. */
  config?: Omit<ThroughputConfig, "asOf">;
}

export interface ReviewArmScore {
  n: number;
  pinball: { p10: number | null; p50: number | null; p90: number | null };
  /** Share of actuals inside [p10, p90]. */
  coverage: ReturnType<typeof intervalCoverage>;
}

export interface ReviewTargetAblation {
  /** Test rows scored by both arms; the two arms always score the same rows. */
  n: number;
  /** Test rows whose target is null. */
  skippedNull: number;
  /** Test rows with a target but no training row carrying it. */
  unscored: number;
  diff: ReviewArmScore;
  base: ReviewArmScore;
  /** diff p50 pinball minus base p50 pinball; negative means the diff key predicts better. */
  deltaP50: number | null;
  insufficient: boolean;
}

export interface ReviewAblationOrigin {
  origin: string;
  horizonEnd: string;
  trainN: number;
  testN: number;
  /** Null when no row was done before the origin, so neither arm could be fitted. */
  targets: Record<ReviewTarget, ReviewTargetAblation> | null;
}

export interface ReviewAblationResult {
  horizonDays: number;
  /** Rows left out because they carry no implementer session. */
  excludedRows: number;
  /** Rows left out of both arms because they lack PR features. */
  skippedMissingFeatures: number;
  /** Rows with features but no `firstImplAt`: they can train but are never tested. */
  skippedNoStart: number;
  origins: ReviewAblationOrigin[];
  pooled: Record<ReviewTarget, ReviewTargetAblation>;
}

interface DatedRow {
  row: ThroughputRow;
  doneMs: number;
  firstMs: number | null;
}

interface ScoredRow {
  actual: number;
  diff: Quantiles;
  base: Quantiles;
}

interface TargetTally {
  scored: ScoredRow[];
  skippedNull: number;
  unscored: number;
}

type Tallies = Record<ReviewTarget, TargetTally>;

function parseMs(value: string, what: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new RangeError(`${what} ${JSON.stringify(value)} is not a date`);
  return ms;
}

function datedRows(rows: readonly ThroughputRow[]): DatedRow[] {
  return rows.map((row) => ({
    row,
    doneMs: parseMs(row.doneAt, `task ${row.taskId}: doneAt`),
    firstMs: row.firstImplAt ? parseMs(row.firstImplAt, `task ${row.taskId}: firstImplAt`) : null,
  }));
}

function scoreRow(row: ThroughputRow, tables: Record<ReviewKey, ReviewTable>, target: ReviewTarget, tally: TargetTally): void {
  const actual = reviewTarget(row, target);
  if (actual === null) {
    tally.skippedNull += 1;
    return;
  }
  const diff = reviewFor(tables.diff, row, target);
  const base = reviewFor(tables.base, row, target);
  if (!diff || !base) tally.unscored += 1;
  else tally.scored.push({ actual, diff: diff.quantiles, base: base.quantiles });
}

function emptyTallies(): Tallies {
  return perTarget(() => ({ scored: [], skippedNull: 0, unscored: 0 }));
}

function armScore(rows: readonly ScoredRow[], arm: ReviewKey): ReviewArmScore {
  const at = (tau: number, pick: (q: Quantiles) => number) => meanPinballLoss(rows.map((row) => ({ actual: row.actual, predicted: pick(row[arm]) })), tau);
  return {
    n: rows.length,
    pinball: { p10: at(0.1, (q) => q.p10), p50: at(0.5, (q) => q.p50), p90: at(0.9, (q) => q.p90) },
    coverage: intervalCoverage(rows.map((row) => ({ actual: row.actual, p10: row[arm].p10, p50: row[arm].p50, p90: row[arm].p90 }))),
  };
}

function summarize(tally: TargetTally): ReviewTargetAblation {
  const diff = armScore(tally.scored, "diff");
  const base = armScore(tally.scored, "base");
  const deltaP50 = diff.pinball.p50 === null || base.pinball.p50 === null ? null : diff.pinball.p50 - base.pinball.p50;
  const n = tally.scored.length;
  return { n, skippedNull: tally.skippedNull, unscored: tally.unscored, diff, base, deltaP50, insufficient: n < MIN_ABLATION_N };
}

function summarizeAll(tallies: Tallies): Record<ReviewTarget, ReviewTargetAblation> {
  return perTarget((target) => summarize(tallies[target]));
}

function fitArms(train: readonly DatedRow[], origin: string, config: ReviewAblationOptions["config"]): Record<ReviewKey, ReviewTable> {
  const rows = train.map((dated) => dated.row);
  const [diff, base] = ARMS.map((key) => reviewTable(rows, { ...config, asOf: origin, key }));
  return { diff: diff!, base: base! };
}

// A row is in train only once done and in test only if first dispatched in the horizon, so a
// row in flight across the origin is in neither.
function runOrigin(dated: readonly DatedRow[], startMs: number, endMs: number, config: ReviewAblationOptions["config"]) {
  const train = dated.filter((d) => d.doneMs < startMs);
  const test = dated.filter((d) => d.firstMs !== null && d.firstMs >= startMs && d.firstMs < endMs);
  const origin = new Date(startMs).toISOString();
  const tallies = emptyTallies();
  if (train.length > 0) {
    const tables = fitArms(train, origin, config);
    for (const { row } of test) for (const target of REVIEW_TARGETS) scoreRow(row, tables, target, tallies[target]);
  }
  const result: ReviewAblationOrigin = {
    origin,
    horizonEnd: new Date(endMs).toISOString(),
    trainN: train.length,
    testN: test.length,
    targets: train.length > 0 ? summarizeAll(tallies) : null,
  };
  return { result, tallies };
}

function validHorizon(horizonDays: number): number {
  if (!(horizonDays > 0) || !Number.isFinite(horizonDays)) throw new RangeError(`horizonDays must be a positive number, got ${horizonDays}`);
  return horizonDays;
}

/**
 * Rolling-origin ablation of the diff key against the kind x size-band key for each review
 * target. Both arms fit and score exactly the same rows, so the key is the only difference.
 */
export function reviewAblation(actuals: readonly ThroughputRow[], options: ReviewAblationOptions): ReviewAblationResult {
  const horizonDays = validHorizon(options.horizonDays ?? DEFAULT_HORIZON_DAYS);
  const eligible = actuals.filter(isEligible);
  const placed = eligible.filter((row) => reviewFeatureKey(row) !== undefined);
  const dated = datedRows(placed);
  const origins = [...new Set(options.origins.map((origin) => parseMs(origin, "origin")))].sort((a, b) => a - b);
  const pooled = emptyTallies();
  const results = origins.map((startMs) => {
    const { result, tallies } = runOrigin(dated, startMs, startMs + horizonDays * MS_PER_DAY, options.config);
    for (const target of REVIEW_TARGETS) {
      pooled[target].scored.push(...tallies[target].scored);
      pooled[target].skippedNull += tallies[target].skippedNull;
      pooled[target].unscored += tallies[target].unscored;
    }
    return result;
  });
  return {
    horizonDays,
    excludedRows: actuals.length - eligible.length,
    skippedMissingFeatures: eligible.length - placed.length,
    skippedNoStart: dated.filter((d) => d.firstMs === null).length,
    origins: results,
    pooled: summarizeAll(pooled),
  };
}
