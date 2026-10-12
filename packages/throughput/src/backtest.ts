import {
  conformalFactor,
  contextLineScore,
  intervalCoverage,
  meanPinballLoss,
  medianAbsLogError,
  predictsOverContextLine,
  spearman,
  widen,
} from "./backtest-metrics.js";
import { classFor, classTable, type ClassTable, type ThroughputConfig } from "./class-table.js";
import { classKey, isEligible, normalizeKind, sizeBand, type TaskClassFacts, type ThroughputRow } from "./rows.js";
import { weightedQuantiles } from "./weighted-quantiles.js";

const MS_PER_DAY = 86_400_000;
const DEFAULT_HORIZON_DAYS = 7;
// Recency weights of 0.5^(days / 1e9) are 1 to within float error, so this fit is unweighted.
const UNWEIGHTED_HALF_LIFE_DAYS = 1e9;
const CONFOUNDED_FLAGS = ["weak-link", "multi-task", "reopened"];

export type BacktestMetric = "implAgentHours" | "reviewAgentHours" | "usd";

/** A task first dispatched but not yet done: right-censored, so counted rather than scored. */
export interface OpenTask extends TaskClassFacts {
  taskId: string;
  initiative: string;
  firstImplAt?: string | null;
}

export interface BacktestOptions {
  /** ISO dates; each one refits on what was known before it. */
  origins: readonly string[];
  horizonDays?: number;
  metric?: BacktestMetric;
  open?: readonly OpenTask[];
  /** Passed to classTable at each origin; `asOf` is always the origin. */
  config?: Omit<ThroughputConfig, "asOf">;
}

export type Coverage = ReturnType<typeof intervalCoverage>;
export type ContextLineScore = NonNullable<ReturnType<typeof contextLineScore>>;

export interface IntervalScore {
  n: number;
  coverage: Coverage;
  pinball: { p10: number | null; p50: number | null; p90: number | null };
  medianAbsLogError: number | null;
}

/** A point forecast has no interval, so only the p50 loss and the log error apply. */
export interface PointScore {
  n: number;
  pinballP50: number | null;
  medianAbsLogError: number | null;
}

export interface GroupScore {
  n: number;
  model: IntervalScore;
  /** Coverage after widening each interval by its class's factor from the previous origin. */
  widenedCoverage: Coverage;
  globalMedian: IntervalScore;
  pointsTimesRate: PointScore;
  unweightedClass: IntervalScore;
  /** Estimate vs actual over rows that carry an estimate. */
  spearman: number | null;
}

export interface ClassScore extends GroupScore {
  /** The widening factor applied here, fitted on the previous origin's rows of this class. */
  conformalFactor: number;
  /** Open tasks of this class first dispatched in the horizon. */
  open: number;
}

export interface Censoring {
  open: number;
  /** open / (open + scored); null when the horizon saw no dispatch. */
  share: number | null;
  byClass: Record<string, number>;
}

interface OriginBase {
  origin: string;
  horizonEnd: string;
  trainN: number;
  testN: number;
  censored: Censoring;
}

export interface SkippedOrigin extends OriginBase {
  status: "skipped";
  reason: "no-training-rows";
}

export interface ScoredOrigin extends OriginBase {
  status: "scored";
  modelHash: string;
  overall: GroupScore;
  /** Rows with none of the weak-link, multi-task or reopened flags. */
  clean: { n: number; coverage: Coverage; widenedCoverage: Coverage };
  classes: Record<string, ClassScore>;
  contextLine: ContextLineScore | null;
}

export type OriginResult = ScoredOrigin | SkippedOrigin;

export interface BacktestResult {
  metric: BacktestMetric;
  horizonDays: number;
  /** Eligible rows with no `firstImplAt`, left out of every split. */
  missingFirstImplAt: number;
  /** Rows flagged `no-impl-session`. */
  excludedRows: number;
  origins: OriginResult[];
  /** Coverage over every scored row of every origin. */
  pooled: { coverage: Coverage; widenedCoverage: Coverage; classes: Record<string, { coverage: Coverage; widenedCoverage: Coverage }> };
}

interface Interval {
  p10: number;
  p50: number;
  p90: number;
}

interface DatedRow {
  row: ThroughputRow;
  key: string;
  value: number;
  doneMs: number;
  firstMs: number;
}

interface ScoredRow {
  key: string;
  actual: number;
  doneMs: number;
  estimate: number | null;
  clean: boolean;
  peakContextTokens: number | null;
  predictsOver: boolean;
  model: Interval;
  widened: Interval;
  globalMedian: Interval;
  unweightedClass: Interval;
  points: number | null;
}

interface OriginFit {
  table: ClassTable;
  unweighted: ClassTable;
  global: Interval;
  hoursPerPoint: number | null;
  trainPeaks: Map<string, number[]>;
}

function parseMs(value: string, what: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new RangeError(`${what} ${JSON.stringify(value)} is not a date`);
  return ms;
}

function keyOf(facts: TaskClassFacts): string {
  return classKey(normalizeKind(facts.kind), sizeBand(facts.estimate));
}

function valueOf(row: ThroughputRow, metric: BacktestMetric): number {
  return metric === "usd" ? row.usd : row[metric].capped;
}

// Float sums depend on order, so rows are put in one canonical order before any summing.
function sortKey(row: ThroughputRow): (string | number)[] {
  return [row.taskId, row.initiative, row.doneAt, row.firstImplAt ?? "", row.implAgentHours.capped, row.reviewAgentHours.capped, row.usd, row.kind ?? "", row.estimate ?? -1];
}

function compareTuples(left: (string | number)[], right: (string | number)[]): number {
  for (let i = 0; i < left.length; i++) {
    if (left[i]! < right[i]!) return -1;
    if (left[i]! > right[i]!) return 1;
  }
  return 0;
}

function datedRows(actuals: readonly ThroughputRow[], metric: BacktestMetric): DatedRow[] {
  const sorted = actuals.filter((row) => isEligible(row) && row.firstImplAt).sort((a, b) => compareTuples(sortKey(a), sortKey(b)));
  return sorted.map((row) => ({
    row,
    key: keyOf(row),
    value: valueOf(row, metric),
    doneMs: parseMs(row.doneAt, `task ${row.taskId}: doneAt`),
    firstMs: parseMs(row.firstImplAt!, `task ${row.taskId}: firstImplAt`),
  }));
}

function hoursPerPoint(train: readonly DatedRow[]): number | null {
  const pointed = train.filter((dated) => (dated.row.estimate ?? 0) > 0);
  const points = pointed.reduce((sum, dated) => sum + dated.row.estimate!, 0);
  if (points === 0) return null;
  return pointed.reduce((sum, dated) => sum + dated.value, 0) / points;
}

function peaksByClass(train: readonly DatedRow[]): Map<string, number[]> {
  const peaks = new Map<string, number[]>();
  for (const dated of train) {
    const peak = dated.row.peakContextTokens;
    if (peak === null || peak === undefined || !Number.isFinite(peak)) continue;
    const group = peaks.get(dated.key);
    if (group) group.push(peak);
    else peaks.set(dated.key, [peak]);
  }
  return peaks;
}

function fitOrigin(train: readonly DatedRow[], originIso: string, config: BacktestOptions["config"]): OriginFit {
  const rows = train.map((dated) => dated.row);
  const global = weightedQuantiles(train.map((dated) => ({ value: dated.value, weight: 1 })));
  return {
    table: classTable(rows, { ...config, asOf: originIso }),
    unweighted: classTable(rows, { ...config, asOf: originIso, halfLifeDays: UNWEIGHTED_HALF_LIFE_DAYS }),
    global: { p10: global.p10, p50: global.p50, p90: global.p90 },
    hoursPerPoint: hoursPerPoint(train),
    trainPeaks: peaksByClass(train),
  };
}

function intervalFor(table: ClassTable, row: ThroughputRow, metric: BacktestMetric): Interval {
  const quantiles = classFor(table, row)[metric];
  return { p10: quantiles.p10, p50: quantiles.p50, p90: quantiles.p90 };
}

function scoreRow(dated: DatedRow, fit: OriginFit, metric: BacktestMetric, factors: ReadonlyMap<string, number>): ScoredRow {
  const { row, key, value } = dated;
  const model = intervalFor(fit.table, row, metric);
  const estimate = row.estimate ?? null;
  const peak = row.peakContextTokens;
  return {
    key,
    actual: value,
    doneMs: dated.doneMs,
    estimate,
    clean: !row.flags?.some((flag) => CONFOUNDED_FLAGS.includes(flag)),
    peakContextTokens: peak !== null && peak !== undefined && Number.isFinite(peak) ? peak : null,
    predictsOver: predictsOverContextLine(fit.trainPeaks.get(key) ?? []),
    model,
    widened: widen({ ...model, actual: value }, factors.get(key) ?? 1),
    globalMedian: fit.global,
    unweightedClass: intervalFor(fit.unweighted, row, metric),
    points: estimate !== null && fit.hoursPerPoint !== null ? estimate * fit.hoursPerPoint : null,
  };
}

function intervalScore(rows: readonly ScoredRow[], pick: (row: ScoredRow) => Interval): IntervalScore {
  const forecasts = rows.map((row) => ({ actual: row.actual, ...pick(row) }));
  const at = (quantile: "p10" | "p50" | "p90", tau: number): number | null =>
    meanPinballLoss(forecasts.map((f) => ({ actual: f.actual, predicted: f[quantile] })), tau);
  return {
    n: rows.length,
    coverage: intervalCoverage(forecasts),
    pinball: { p10: at("p10", 0.1), p50: at("p50", 0.5), p90: at("p90", 0.9) },
    medianAbsLogError: medianAbsLogError(forecasts.map((f) => ({ actual: f.actual, predicted: f.p50 }))),
  };
}

function pointScore(rows: readonly ScoredRow[]): PointScore {
  const forecasts = rows.flatMap((row) => (row.points === null ? [] : [{ actual: row.actual, predicted: row.points }]));
  return { n: forecasts.length, pinballP50: meanPinballLoss(forecasts, 0.5), medianAbsLogError: medianAbsLogError(forecasts) };
}

function coverageOf(rows: readonly ScoredRow[], pick: (row: ScoredRow) => Interval): Coverage {
  return intervalCoverage(rows.map((row) => ({ actual: row.actual, ...pick(row) })));
}

function groupScore(rows: readonly ScoredRow[]): GroupScore {
  const estimated = rows.filter((row) => row.estimate !== null);
  return {
    n: rows.length,
    model: intervalScore(rows, (row) => row.model),
    widenedCoverage: coverageOf(rows, (row) => row.widened),
    globalMedian: intervalScore(rows, (row) => row.globalMedian),
    pointsTimesRate: pointScore(rows),
    unweightedClass: intervalScore(rows, (row) => row.unweightedClass),
    spearman: spearman(estimated.map((row) => row.estimate!), estimated.map((row) => row.actual)),
  };
}

function groupBy<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return new Map([...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function censoring(open: readonly OpenTask[], startMs: number, endMs: number, scored: number): Censoring {
  const inWindow = open.filter((task) => {
    if (!task.firstImplAt) return false;
    const ms = parseMs(task.firstImplAt, `open task ${task.taskId}: firstImplAt`);
    return ms >= startMs && ms < endMs;
  });
  const byClass = Object.fromEntries([...groupBy(inWindow, keyOf)].map(([key, tasks]) => [key, tasks.length]));
  const total = inWindow.length + scored;
  return { open: inWindow.length, share: total === 0 ? null : inWindow.length / total, byClass };
}

// Only previous-origin rows already done at this origin may calibrate it; later ones were not yet known.
function factorsKnownAt(previous: readonly ScoredRow[], startMs: number): Map<string, number> {
  const known = previous.filter((row) => row.doneMs < startMs);
  return new Map([...groupBy(known, (row) => row.key)].map(([key, group]) => [key, conformalFactor(group.map((row) => ({ actual: row.actual, ...row.model })))]));
}

function contextLine(rows: readonly ScoredRow[]): ContextLineScore | null {
  const carrying = rows.flatMap((row) => (row.peakContextTokens === null ? [] : [{ predictedOver: row.predictsOver, peakContextTokens: row.peakContextTokens }]));
  return contextLineScore(carrying);
}

function scoredOrigin(base: OriginBase, fit: OriginFit, rows: readonly ScoredRow[], factors: ReadonlyMap<string, number>): ScoredOrigin {
  const clean = rows.filter((row) => row.clean);
  const classes = [...groupBy(rows, (row) => row.key)].map(([key, group]): [string, ClassScore] => [
    key,
    { ...groupScore(group), conformalFactor: factors.get(key) ?? 1, open: base.censored.byClass[key] ?? 0 },
  ]);
  return {
    ...base,
    status: "scored",
    modelHash: fit.table.modelHash,
    overall: groupScore(rows),
    clean: { n: clean.length, coverage: coverageOf(clean, (row) => row.model), widenedCoverage: coverageOf(clean, (row) => row.widened) },
    classes: Object.fromEntries(classes),
    contextLine: contextLine(rows),
  };
}

function pooled(rows: readonly ScoredRow[]): BacktestResult["pooled"] {
  const both = (group: readonly ScoredRow[]) => ({ coverage: coverageOf(group, (row) => row.model), widenedCoverage: coverageOf(group, (row) => row.widened) });
  return { ...both(rows), classes: Object.fromEntries([...groupBy(rows, (row) => row.key)].map(([key, group]) => [key, both(group)])) };
}

function validHorizon(horizonDays: number): number {
  if (!(horizonDays > 0) || !Number.isFinite(horizonDays)) throw new RangeError(`horizonDays must be a positive number, got ${horizonDays}`);
  return horizonDays;
}

/**
 * Rolling-origin back-test of classTable. At each origin it fits on rows done and first
 * dispatched before the origin, then scores rows first dispatched in the next horizon against
 * the fit and three baselines. Pure: equal input gives equal output, whatever the row order.
 */
export function backtest(actuals: readonly ThroughputRow[], options: BacktestOptions): BacktestResult {
  const metric = options.metric ?? "implAgentHours";
  const horizonDays = validHorizon(options.horizonDays ?? DEFAULT_HORIZON_DAYS);
  const dated = datedRows(actuals, metric);
  const open = [...(options.open ?? [])].sort((a, b) => compareTuples([a.taskId, a.initiative], [b.taskId, b.initiative]));
  const origins = [...new Set(options.origins.map((origin) => parseMs(origin, "origin")))].sort((a, b) => a - b);
  const results: OriginResult[] = [];
  const allScored: ScoredRow[] = [];
  let previous: ScoredRow[] = [];
  for (const startMs of origins) {
    const { result, scored } = runOrigin(dated, open, startMs, startMs + horizonDays * MS_PER_DAY, { metric, config: options.config, previous });
    results.push(result);
    allScored.push(...scored);
    previous = scored;
  }
  const eligible = actuals.filter(isEligible).length;
  return { metric, horizonDays, missingFirstImplAt: eligible - dated.length, excludedRows: actuals.length - eligible, origins: results, pooled: pooled(allScored) };
}

interface OriginContext {
  metric: BacktestMetric;
  config: BacktestOptions["config"];
  /** The previous origin's scored rows, which fit this origin's conformal factors. */
  previous: readonly ScoredRow[];
}

function runOrigin(dated: readonly DatedRow[], open: readonly OpenTask[], startMs: number, endMs: number, context: OriginContext): { result: OriginResult; scored: ScoredRow[] } {
  const train = dated.filter((row) => row.doneMs < startMs && row.firstMs < startMs);
  const test = dated.filter((row) => row.firstMs >= startMs && row.firstMs < endMs);
  const origin = new Date(startMs).toISOString();
  const base: OriginBase = { origin, horizonEnd: new Date(endMs).toISOString(), trainN: train.length, testN: test.length, censored: censoring(open, startMs, endMs, test.length) };
  if (train.length === 0) return { result: { ...base, status: "skipped", reason: "no-training-rows" }, scored: [] };
  const fit = fitOrigin(train, origin, context.config);
  const factors = factorsKnownAt(context.previous, startMs);
  const scored = test.map((row) => scoreRow(row, fit, context.metric, factors));
  return { result: scoredOrigin(base, fit, scored, factors), scored };
}
