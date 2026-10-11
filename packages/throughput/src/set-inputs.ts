import type { BacktestMetric } from "./backtest.js";
import { classFor, type BackoffLevel, type ClassTable } from "./class-table.js";
import { classKey, isEligible, normalizeKind, sizeBand, type TaskClassFacts, type ThroughputRow } from "./rows.js";

const MS_PER_DAY = 86_400_000;
const GLOBAL_KEY = "*";
export const DEFAULT_WEEK_MIN_TASKS = 8;

export interface ClosureStats {
  n: number;
  weightedN: number;
  /** Recency-weighted share of rows closed with no implementer session. */
  rate: number;
}

export interface ClosureRates {
  asOf: string;
  halfLifeDays: number;
  minN: number;
  levels: {
    class: Record<string, ClosureStats>;
    kind: Record<string, ClosureStats>;
    band: Record<string, ClosureStats>;
    initiative: Record<string, ClosureStats>;
    global: ClosureStats;
  };
}

export interface ClosureLookup {
  rate: number;
  level: BackoffLevel;
  levelKey: string;
}

export interface WeekEffect {
  /** UTC ISO weeks, as the date of their Monday, ascending. */
  weeks: string[];
  /** Per metric, one multiplier per week, normalised to mean 1. */
  multipliers: Record<BacktestMetric, number[]>;
}

export interface WeekEffectOptions {
  /** Weeks with fewer rows are dropped. Defaults to 8. */
  minTasks?: number;
}

interface ClosureRow {
  key: string;
  kind: string;
  band: string;
  initiative: string;
  weight: number;
  closed: boolean;
}

function parseMs(value: string, taskId: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new RangeError(`task ${taskId}: ${JSON.stringify(value)} is not a date`);
  return ms;
}

// Float sums depend on order, so rows are summed in one canonical order whatever the input order.
function byKey<T extends { key: string }>(a: T, b: T): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function closureStats(rows: readonly ClosureRow[]): ClosureStats {
  const weightedN = rows.reduce((sum, row) => sum + row.weight, 0);
  const closedWeight = rows.reduce((sum, row) => sum + (row.closed ? row.weight : 0), 0);
  return { n: rows.length, weightedN, rate: weightedN > 0 ? closedWeight / weightedN : 0 };
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function closureStatsBy(rows: readonly ClosureRow[], keyOf: (row: ClosureRow) => string): Record<string, ClosureStats> {
  const groups = groupBy(rows, keyOf);
  return Object.fromEntries([...groups.keys()].sort().map((key) => [key, closureStats(groups.get(key)!)]));
}

/**
 * Per-level recency-weighted rate of zero-agent closures (rows flagged `no-impl-session`),
 * weighted with the table's `asOf` and half-life so it matches the table's classes.
 */
export function closureRates(actuals: readonly ThroughputRow[], table: ClassTable): ClosureRates {
  const asOfMs = Date.parse(table.asOf);
  const rows = actuals
    .map((row): ClosureRow => {
      const age = Math.max(0, asOfMs - parseMs(row.doneAt, row.taskId)) / MS_PER_DAY;
      const closed = !isEligible(row);
      return {
        key: JSON.stringify([row.taskId, row.initiative, row.doneAt, closed, row.kind ?? "", row.estimate ?? -1]),
        kind: normalizeKind(row.kind),
        band: sizeBand(row.estimate),
        initiative: row.initiative,
        weight: 0.5 ** (age / table.halfLifeDays),
        closed,
      };
    })
    .sort(byKey);
  const levels = {
    class: closureStatsBy(rows, (row) => `${row.kind}/${row.band}`),
    kind: closureStatsBy(rows, (row) => row.kind),
    band: closureStatsBy(rows, (row) => row.band),
    initiative: closureStatsBy(rows, (row) => row.initiative),
    global: closureStats(rows),
  };
  return { asOf: table.asOf, halfLifeDays: table.halfLifeDays, minN: table.minN, levels };
}

/** One task's closure rate, backing off class, kind, size band, initiative, then global. */
export function closureFor(rates: ClosureRates, facts: TaskClassFacts): ClosureLookup {
  const kind = normalizeKind(facts.kind);
  const band = sizeBand(facts.estimate);
  const chain: [BackoffLevel, string, Record<string, ClosureStats>][] = [
    ["class", classKey(kind, band), rates.levels.class],
    ["kind", kind, rates.levels.kind],
    ["band", band, rates.levels.band],
  ];
  if (facts.initiative) chain.push(["initiative", facts.initiative, rates.levels.initiative]);
  for (const [level, levelKey, stats] of chain) {
    const found = Object.hasOwn(stats, levelKey) ? stats[levelKey] : undefined;
    if (found && found.weightedN >= rates.minN) return { rate: found.rate, level, levelKey };
  }
  return { rate: rates.levels.global.rate, level: "global", levelKey: GLOBAL_KEY };
}

function isoWeek(row: ThroughputRow): string {
  const ms = parseMs(row.firstImplAt ?? row.doneAt, row.taskId);
  const dayStart = Math.floor(ms / MS_PER_DAY) * MS_PER_DAY;
  const daysSinceMonday = (new Date(dayStart).getUTCDay() + 6) % 7;
  return new Date(dayStart - daysSinceMonday * MS_PER_DAY).toISOString().slice(0, 10);
}

function weekRatio(rows: readonly ThroughputRow[], table: ClassTable, metric: BacktestMetric): number {
  const actualOf = (row: ThroughputRow): number => (metric === "usd" ? row.usd : row[metric].capped);
  const actual = rows.reduce((sum, row) => sum + actualOf(row), 0);
  const expected = rows.reduce((sum, row) => sum + classFor(table, row)[metric].p50, 0);
  return expected > 0 ? actual / expected : 1;
}

function normaliseToMeanOne(ratios: readonly number[]): number[] {
  const mean = ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
  return mean > 0 ? ratios.map((ratio) => ratio / mean) : ratios.map(() => 1);
}

/**
 * Per-week actual / class-p50 ratios over eligible rows, normalised to mean 1 per metric, so a
 * shared week multiplier widens a set forecast without shifting it.
 */
export function weekEffects(actuals: readonly ThroughputRow[], table: ClassTable, options: WeekEffectOptions = {}): WeekEffect {
  const minTasks = options.minTasks ?? DEFAULT_WEEK_MIN_TASKS;
  const sorted = actuals
    .filter(isEligible)
    .map((row) => ({ key: JSON.stringify([row.taskId, row.initiative, row.doneAt, row.firstImplAt ?? ""]), row }))
    .sort(byKey);
  const byWeek = groupBy(sorted.map(({ row }) => row), isoWeek);
  const weeks = [...byWeek.keys()].filter((week) => byWeek.get(week)!.length >= minTasks).sort();
  const multipliersOf = (metric: BacktestMetric): number[] => normaliseToMeanOne(weeks.map((week) => weekRatio(byWeek.get(week)!, table, metric)));
  return {
    weeks,
    multipliers: { implAgentHours: multipliersOf("implAgentHours"), reviewAgentHours: multipliersOf("reviewAgentHours"), usd: multipliersOf("usd") },
  };
}
