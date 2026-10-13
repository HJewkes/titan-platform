import { DEFAULT_HALF_LIFE_DAYS, DEFAULT_MIN_N, type ThroughputConfig, type Watermark } from "./class-table.js";
import { modelHash, PACKAGE_VERSION } from "./model-hash.js";
import { classKey, isEligible, normalizeKind, sizeBand, type StageMinutesLike, type ThroughputRow } from "./rows.js";
import { weightedQuantiles, type Quantiles } from "./weighted-quantiles.js";

export const REVIEW_TARGETS = ["reviewAgentHours", "reviewRounds", "postPrWallHours"] as const;
export type ReviewTarget = (typeof REVIEW_TARGETS)[number];

/** One value per review target, built without a cast. */
export function perTarget<T>(make: (target: ReviewTarget) => T): Record<ReviewTarget, T> {
  return { reviewAgentHours: make("reviewAgentHours"), reviewRounds: make("reviewRounds"), postPrWallHours: make("postPrWallHours") };
}
/** `diff` keys on review class x lead touch; `base` on kind x size band, the plan-time baseline. */
export type ReviewKey = "diff" | "base";
/** `group` is the review class for the diff key and the kind for the base key. */
export type ReviewBackoffLevel = "key" | "group" | "global";

export const NO_PR_KEY = "nopr";
// queued is time before Shepherd picked the PR up; it overlaps implementer time, so it is left out.
const POST_PR_STAGES = ["ci", "review", "re-review", "hold", "land"] as const;
const MS_PER_DAY = 86_400_000;
const GLOBAL_KEY = "*";

export type ReviewFacts = Pick<ThroughputRow, "prClass" | "touches" | "kind" | "estimate">;

export interface ReviewLevelStats {
  n: number;
  /** Rows after recency weighting; the back-off threshold applies to this. */
  weightedN: number;
  quantiles: Quantiles;
}

export interface ReviewEntry extends ReviewLevelStats {
  level: ReviewBackoffLevel;
  levelKey: string;
}

export interface ReviewTargetTable {
  /** Rows that carry this target. */
  n: number;
  /** Placed rows left out because this target is null on them. */
  skippedNull: number;
  keys: Record<string, ReviewLevelStats>;
  groups: Record<string, ReviewLevelStats>;
  global: ReviewLevelStats | null;
}

export interface ReviewTableConfig extends ThroughputConfig {
  key: ReviewKey;
}

export interface ReviewTable {
  modelHash: string;
  packageVersion: string;
  key: ReviewKey;
  watermark: Watermark;
  asOf: string;
  halfLifeDays: number;
  minN: number;
  /** Rows left out because they carry no implementer session. */
  excludedRows: number;
  /** Rows left out because the key needs PR features they do not carry. */
  skippedMissingFeatures: number;
  targets: Record<ReviewTarget, ReviewTargetTable>;
}

interface Placement {
  key: string;
  group: string;
}

interface WeightedRow extends Placement {
  weight: number;
  values: Record<ReviewTarget, number | null>;
}

/**
 * `<prClass>/<lead touch>`, `nopr` for a task with no PR, or undefined when the row lacks PR
 * features (no cache entry), which callers skip and count.
 */
export function reviewFeatureKey(row: ReviewFacts): string | undefined {
  if (row.prClass === null && row.touches?.length === 0) return NO_PR_KEY;
  if (!row.prClass || !row.touches) return undefined;
  return `${row.prClass}/${row.touches[0] ?? "none"}`;
}

function placement(row: ReviewFacts, key: ReviewKey): Placement | undefined {
  if (key === "base") {
    const kind = normalizeKind(row.kind);
    return { key: classKey(kind, sizeBand(row.estimate)), group: kind };
  }
  const featureKey = reviewFeatureKey(row);
  if (featureKey === undefined) return undefined;
  return { key: featureKey, group: featureKey === NO_PR_KEY ? NO_PR_KEY : row.prClass! };
}

function postPrWallHours(stages: StageMinutesLike | null | undefined): number | null {
  if (!stages) return null;
  return POST_PR_STAGES.reduce((sum, stage) => sum + (stages[stage] ?? 0), 0) / 60;
}

/** The row's value for one review target; null when unknown. */
export function reviewTarget(row: ThroughputRow, target: ReviewTarget): number | null {
  if (target === "reviewAgentHours") return row.reviewAgentHours.capped;
  if (target === "reviewRounds") return row.reviewRounds ?? null;
  return postPrWallHours(row.stageMinutes);
}

function doneAtMs(row: ThroughputRow): number {
  const ms = Date.parse(row.doneAt);
  if (Number.isNaN(ms)) throw new RangeError(`task ${row.taskId}: doneAt ${JSON.stringify(row.doneAt)} is not a date`);
  return ms;
}

// Float sums depend on order, so rows are put in one canonical order before any summing.
function compareRows(a: ThroughputRow, b: ThroughputRow): number {
  const left = [a.taskId, a.initiative, a.doneAt];
  const right = [b.taskId, b.initiative, b.doneAt];
  for (let i = 0; i < left.length; i++) {
    if (left[i]! < right[i]!) return -1;
    if (left[i]! > right[i]!) return 1;
  }
  return 0;
}

function weighRow(row: ThroughputRow, place: Placement, asOfMs: number, halfLifeDays: number): WeightedRow {
  const weight = 0.5 ** (Math.max(0, asOfMs - doneAtMs(row)) / MS_PER_DAY / halfLifeDays);
  return { ...place, weight, values: perTarget((target) => reviewTarget(row, target)) };
}

function levelStats(rows: readonly WeightedRow[], target: ReviewTarget): ReviewLevelStats {
  const points = rows.map((row) => ({ value: row.values[target]!, weight: row.weight }));
  return { n: rows.length, weightedN: rows.reduce((sum, row) => sum + row.weight, 0), quantiles: weightedQuantiles(points) };
}

function statsBy(rows: readonly WeightedRow[], target: ReviewTarget, keyOf: (row: WeightedRow) => string): Record<string, ReviewLevelStats> {
  const groups = new Map<string, WeightedRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const keys = [...groups.keys()].sort();
  return Object.fromEntries(keys.map((key) => [key, levelStats(groups.get(key)!, target)]));
}

function targetTable(rows: readonly WeightedRow[], target: ReviewTarget): ReviewTargetTable {
  const carrying = rows.filter((row) => row.values[target] !== null);
  return {
    n: carrying.length,
    skippedNull: rows.length - carrying.length,
    keys: statsBy(carrying, target, (row) => row.key),
    groups: statsBy(carrying, target, (row) => row.group),
    global: carrying.length === 0 ? null : levelStats(carrying, target),
  };
}

interface FitSettings {
  asOf: string;
  asOfMs: number;
  halfLifeDays: number;
  minN: number;
}

function fitSettings(config: ThroughputConfig, newestDoneAt: string): FitSettings {
  const asOfMs = Date.parse(config.asOf ?? newestDoneAt);
  if (Number.isNaN(asOfMs)) throw new RangeError(`asOf ${JSON.stringify(config.asOf)} is not a date`);
  const halfLifeDays = config.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  if (!(halfLifeDays > 0) || !Number.isFinite(halfLifeDays)) throw new RangeError(`halfLifeDays must be a positive number, got ${halfLifeDays}`);
  const minN = config.minN ?? DEFAULT_MIN_N;
  if (!(minN >= 0) || !Number.isFinite(minN)) throw new RangeError(`minN must be a non-negative number, got ${minN}`);
  return { asOf: new Date(asOfMs).toISOString(), asOfMs, halfLifeDays, minN };
}

function placeRows(rows: readonly ThroughputRow[], key: ReviewKey): { row: ThroughputRow; place: Placement }[] {
  return rows.flatMap((row) => {
    const place = placement(row, key);
    return place ? [{ row, place }] : [];
  });
}

/**
 * Recency-weighted quantiles of reviewer agent-hours, review rounds and post-PR wall hours,
 * keyed on review class x lead touch (`diff`) or kind x size band (`base`), with back-off to
 * the group (class or kind) then global. Pure: equal rows and config give equal output.
 */
export function reviewTable(actuals: readonly ThroughputRow[], config: ReviewTableConfig): ReviewTable {
  const eligible = actuals.filter(isEligible).sort(compareRows);
  const placed = placeRows(eligible, config.key);
  if (placed.length === 0) throw new RangeError(`reviewTable needs at least one row the ${config.key} key can place`);
  const newestMs = placed.reduce((newest, { row }) => Math.max(newest, doneAtMs(row)), Number.NEGATIVE_INFINITY);
  const watermark: Watermark = { newestDoneAt: new Date(newestMs).toISOString(), minerIndexedAt: config.minerIndexedAt ?? null };
  const { asOf, asOfMs, halfLifeDays, minN } = fitSettings(config, watermark.newestDoneAt);
  const weighted = placed.map(({ row, place }) => weighRow(row, place, asOfMs, halfLifeDays));
  const settings = { asOf, halfLifeDays, minN };
  const hash = modelHash({ config: settings, watermark, packageVersion: PACKAGE_VERSION, reviewModel: 1, key: config.key });
  return {
    modelHash: hash,
    packageVersion: PACKAGE_VERSION,
    key: config.key,
    watermark,
    ...settings,
    excludedRows: actuals.length - eligible.length,
    skippedMissingFeatures: eligible.length - placed.length,
    targets: perTarget((target) => targetTable(weighted, target)),
  };
}

/**
 * The quantiles one task gets for a target, backing off key, group, then global. Undefined when
 * the table's key cannot place the task or no training row carries the target.
 */
export function reviewFor(table: ReviewTable, facts: ReviewFacts, target: ReviewTarget): ReviewEntry | undefined {
  const place = placement(facts, table.key);
  const stats = table.targets[target];
  if (!place || !stats.global) return undefined;
  const chain: [ReviewBackoffLevel, string, Record<string, ReviewLevelStats>][] = [
    ["key", place.key, stats.keys],
    ["group", place.group, stats.groups],
  ];
  for (const [level, levelKey, levels] of chain) {
    const found = Object.hasOwn(levels, levelKey) ? levels[levelKey] : undefined;
    if (found && found.weightedN >= table.minN) return { level, levelKey, ...found };
  }
  return { level: "global", levelKey: GLOBAL_KEY, ...stats.global };
}
