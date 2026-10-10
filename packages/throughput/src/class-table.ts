import { modelHash, PACKAGE_VERSION } from "./model-hash.js";
import { classKey, isEligible, normalizeKind, sizeBand, type SizeBand, type TaskClassFacts, type ThroughputRow } from "./rows.js";
import { weightedQuantiles, type Quantiles } from "./weighted-quantiles.js";

export const DEFAULT_HALF_LIFE_DAYS = 21;
export const DEFAULT_MIN_N = 20;
const MS_PER_DAY = 86_400_000;
const GLOBAL_KEY = "*";

export type BackoffLevel = "class" | "kind" | "band" | "initiative" | "global";

export interface LevelStats {
  /** Rows at this level. */
  n: number;
  /** Rows at this level after recency weighting; the back-off threshold applies to this. */
  weightedN: number;
  implAgentHours: Quantiles;
  reviewAgentHours: Quantiles;
  usd: Quantiles;
}

/** The quantiles a class gets, and the back-off level and key they came from. */
export interface ClassEntry extends LevelStats {
  kind: string;
  band: SizeBand;
  level: BackoffLevel;
  levelKey: string;
}

export interface ThroughputConfig {
  /** The time recency weights count back from. Defaults to the newest `doneAt`. */
  asOf?: string;
  /** The session miner's `lastIndexedAt`, recorded in the watermark. */
  minerIndexedAt?: string;
  halfLifeDays?: number;
  minN?: number;
}

export interface Watermark {
  newestDoneAt: string;
  minerIndexedAt: string | null;
}

export interface ClassTable {
  modelHash: string;
  packageVersion: string;
  watermark: Watermark;
  asOf: string;
  halfLifeDays: number;
  minN: number;
  /** Rows left out because they carry no implementer session. */
  excludedRows: number;
  /** Every observed kind x size band, already backed off without an initiative. */
  classes: Record<string, ClassEntry>;
  levels: {
    class: Record<string, LevelStats>;
    kind: Record<string, LevelStats>;
    band: Record<string, LevelStats>;
    initiative: Record<string, LevelStats>;
    global: LevelStats;
  };
}

interface WeightedRow {
  kind: string;
  band: SizeBand;
  initiative: string;
  weight: number;
  impl: number;
  review: number;
  usd: number;
}

function doneAtMs(row: ThroughputRow): number {
  const ms = Date.parse(row.doneAt);
  if (Number.isNaN(ms)) throw new RangeError(`task ${row.taskId}: doneAt ${JSON.stringify(row.doneAt)} is not a date`);
  return ms;
}

// Float sums depend on order, so rows are put in one canonical order before any summing.
function compareRows(a: ThroughputRow, b: ThroughputRow): number {
  const left = [a.taskId, a.initiative, a.doneAt, a.implAgentHours.capped, a.reviewAgentHours.capped, a.usd, a.kind ?? "", a.estimate ?? -1];
  const right = [b.taskId, b.initiative, b.doneAt, b.implAgentHours.capped, b.reviewAgentHours.capped, b.usd, b.kind ?? "", b.estimate ?? -1];
  for (let i = 0; i < left.length; i++) {
    if (left[i]! < right[i]!) return -1;
    if (left[i]! > right[i]!) return 1;
  }
  return 0;
}

function weighRows(rows: readonly ThroughputRow[], asOfMs: number, halfLifeDays: number): WeightedRow[] {
  return [...rows].sort(compareRows).map((row) => ({
    kind: normalizeKind(row.kind),
    band: sizeBand(row.estimate),
    initiative: row.initiative,
    weight: 0.5 ** (Math.max(0, asOfMs - doneAtMs(row)) / MS_PER_DAY / halfLifeDays),
    impl: row.implAgentHours.capped,
    review: row.reviewAgentHours.capped,
    usd: row.usd,
  }));
}

function levelStats(rows: readonly WeightedRow[]): LevelStats {
  const of = (metric: (row: WeightedRow) => number): Quantiles => weightedQuantiles(rows.map((row) => ({ value: metric(row), weight: row.weight })));
  return {
    n: rows.length,
    weightedN: rows.reduce((sum, row) => sum + row.weight, 0),
    implAgentHours: of((row) => row.impl),
    reviewAgentHours: of((row) => row.review),
    usd: of((row) => row.usd),
  };
}

function statsBy(rows: readonly WeightedRow[], keyOf: (row: WeightedRow) => string): Record<string, LevelStats> {
  const groups = new Map<string, WeightedRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const keys = [...groups.keys()].sort();
  return Object.fromEntries(keys.map((key) => [key, levelStats(groups.get(key)!)]));
}

interface ClassPlace {
  kind: string;
  band: SizeBand;
  initiative?: string | null;
}

function resolveClass(levels: ClassTable["levels"], minN: number, { kind, band, initiative }: ClassPlace): ClassEntry {
  const chain: [BackoffLevel, string, Record<string, LevelStats>][] = [
    ["class", classKey(kind, band), levels.class],
    ["kind", kind, levels.kind],
    ["band", band, levels.band],
  ];
  if (initiative) chain.push(["initiative", initiative, levels.initiative]);
  for (const [level, levelKey, stats] of chain) {
    const found = Object.hasOwn(stats, levelKey) ? stats[levelKey] : undefined;
    if (found && found.weightedN >= minN) return { kind, band, level, levelKey, ...found };
  }
  return { kind, band, level: "global", levelKey: GLOBAL_KEY, ...levels.global };
}

/** The quantiles for one task's class, backing off kind, size band, initiative, then global. */
export function classFor(table: ClassTable, facts: TaskClassFacts): ClassEntry {
  const place = { kind: normalizeKind(facts.kind), band: sizeBand(facts.estimate), initiative: facts.initiative };
  return resolveClass(table.levels, table.minN, place);
}

function buildLevels(weighted: readonly WeightedRow[]): ClassTable["levels"] {
  return {
    class: statsBy(weighted, (row) => classKey(row.kind, row.band)),
    kind: statsBy(weighted, (row) => row.kind),
    band: statsBy(weighted, (row) => row.band),
    initiative: statsBy(weighted, (row) => row.initiative),
    global: levelStats(weighted),
  };
}

// A class spans initiatives, so the table's own entries skip the initiative step; classFor takes it.
function buildClasses(weighted: readonly WeightedRow[], levels: ClassTable["levels"], minN: number): Record<string, ClassEntry> {
  const places = new Map(weighted.map((row) => [classKey(row.kind, row.band), { kind: row.kind, band: row.band }]));
  const keys = [...places.keys()].sort();
  return Object.fromEntries(keys.map((key) => [key, resolveClass(levels, minN, places.get(key)!)]));
}

/**
 * Per-class weighted quantiles of implementer hours, reviewer hours and USD, keyed kind x size
 * band. Pure: equal rows and config give equal output, whatever the row order.
 */
export function classTable(actuals: readonly ThroughputRow[], config: ThroughputConfig = {}): ClassTable {
  const eligible = actuals.filter(isEligible);
  if (eligible.length === 0) throw new RangeError("classTable needs at least one row with an implementer session");
  const newestMs = eligible.reduce((newest, row) => Math.max(newest, doneAtMs(row)), Number.NEGATIVE_INFINITY);
  const watermark: Watermark = { newestDoneAt: new Date(newestMs).toISOString(), minerIndexedAt: config.minerIndexedAt ?? null };
  const asOf = config.asOf ?? watermark.newestDoneAt;
  const halfLifeDays = config.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const minN = config.minN ?? DEFAULT_MIN_N;
  const weighted = weighRows(eligible, Date.parse(asOf), halfLifeDays);
  const levels = buildLevels(weighted);
  const hash = modelHash({ config: { asOf, halfLifeDays, minN }, watermark, packageVersion: PACKAGE_VERSION });
  return {
    modelHash: hash,
    packageVersion: PACKAGE_VERSION,
    watermark,
    asOf,
    halfLifeDays,
    minN,
    excludedRows: actuals.length - eligible.length,
    classes: buildClasses(weighted, levels, minN),
    levels,
  };
}
