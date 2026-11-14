import { pairedCases, type Blocks, type CellIndex } from "./blocks.js";
import type { Cell } from "./load.js";
import { costPerSuccess, holm, mde, mean, pairedDiff, quantile, rateOf, significant, type PairedDiff, type RateCell, type Range } from "./stats.js";

/** A per-case score in [0, 1], or null when the case does not bear on it. */
export type Metric = (cell: Cell) => number | null;

export interface TrackContext {
  track: string;
  blocks: Blocks;
  index: CellIndex;
  /** Arms in table order: production first, then core, then side arms. */
  arms: string[];
}

export interface TableSpec {
  id: string;
  title: string;
  primaryLabel: string;
  include: (cell: Cell) => boolean;
  primary: Metric;
  secondary: Record<string, Metric>;
  lowerIsBetter?: boolean;
  strataKeys: readonly string[];
  /** The per-case score comparisons pair on, when it differs from the row rate (P: a tie is half a win, the anchor 0.5). */
  compareMetric?: Metric;
}

interface ArmRow {
  arm: string;
  side: boolean;
  n: number;
  primary: RateCell | null;
  secondary: Record<string, RateCell | null>;
  byStratum: Record<string, RateCell | null>;
}

interface Comparison {
  table: string;
  arm: string;
  production: string;
  diff: PairedDiff | null;
  pHolm: number | null;
  significant: boolean;
  /** Set only where the comparison is not significant after Holm. */
  mde: number | null;
}

export interface Table {
  id: string;
  title: string;
  primaryLabel: string;
  lowerIsBetter: boolean;
  rows: ArmRow[];
  comparisons: Comparison[];
  chart: { arm: string; usdPerCase: number | null; rate: number | null }[];
}

/** The arm's cells on the cases it is paired on, optionally narrowed. */
export function armCells(ctx: TrackContext, arm: string, include: (cell: Cell) => boolean = () => true): Cell[] {
  const mine = ctx.index.get(arm);
  return pairedCases(ctx.blocks, ctx.index, arm).flatMap((hash) => {
    const cell = mine?.get(hash);
    return cell !== undefined && include(cell) ? [cell] : [];
  });
}

const stratumLabel = (cell: Cell, keys: readonly string[]): string => keys.map((key) => `${key}=${cell.stratum[key] ?? "?"}`).join(",");

function byStratum(cells: readonly Cell[], spec: TableSpec): Record<string, RateCell | null> {
  const groups = new Map<string, Cell[]>();
  for (const cell of cells) groups.set(stratumLabel(cell, spec.strataKeys), [...(groups.get(stratumLabel(cell, spec.strataKeys)) ?? []), cell]);
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, group]) => [label, rateOf(group.map(spec.primary))]));
}

function armRow(ctx: TrackContext, spec: TableSpec, arm: string): ArmRow {
  const cells = armCells(ctx, arm, spec.include);
  const primary = rateOf(cells.map(spec.primary));
  const secondary = Object.fromEntries(Object.entries(spec.secondary).map(([name, metric]) => [name, rateOf(cells.map(metric))]));
  return { arm, side: ctx.blocks.sideArms.includes(arm), n: primary?.n ?? 0, primary, secondary, byStratum: byStratum(cells, spec) };
}

/** Paired per-case scores of arm and production on the arm's paired cases, dropping cases either side does not score. */
function pairedScores(ctx: TrackContext, arm: string, metric: Metric, include: (cell: Cell) => boolean): { arm: number[]; production: number[] } {
  const production = ctx.index.get(ctx.blocks.production);
  const pairs = armCells(ctx, arm, include).flatMap((cell) => {
    const twin = production?.get(cell.caseHash);
    const a = metric(cell);
    const b = twin === undefined ? null : metric(twin);
    return a === null || b === null ? [] : [[a, b] as const];
  });
  return { arm: pairs.map(([a]) => a), production: pairs.map(([, b]) => b) };
}

function comparison(ctx: TrackContext, spec: TableSpec, arm: string): Comparison {
  const scores = pairedScores(ctx, arm, spec.compareMetric ?? spec.primary, spec.include);
  const diff = pairedDiff(scores.arm, scores.production, `${ctx.track}:${spec.id}:${arm}`);
  return { table: spec.id, arm, production: ctx.blocks.production, diff, pHolm: null, significant: false, mde: mde(scores.arm, scores.production) };
}

export function buildTable(ctx: TrackContext, spec: TableSpec): Table {
  const rows = ctx.arms.map((arm) => armRow(ctx, spec, arm));
  const comparisons = ctx.arms.filter((arm) => arm !== ctx.blocks.production).map((arm) => comparison(ctx, spec, arm));
  const chart = ctx.arms.map((arm) => ({ arm, usdPerCase: mean(armCells(ctx, arm, spec.include).map((cell) => cell.listUsd)), rate: rows.find((row) => row.arm === arm)?.primary?.rate ?? null }));
  return { id: spec.id, title: spec.title, primaryLabel: spec.primaryLabel, lowerIsBetter: spec.lowerIsBetter === true, rows, comparisons, chart };
}

/** Holm across every comparison of a track; a comparison with no pairs keeps p null and stays out of the family. */
export function applyHolm(tables: readonly Table[]): void {
  const tested = tables.flatMap((table) => table.comparisons).filter((entry) => entry.diff !== null);
  const adjusted = holm(tested.map((entry) => entry.diff?.p ?? 1));
  tested.forEach((entry, i) => {
    entry.pHolm = adjusted[i] ?? null;
    entry.significant = entry.pHolm !== null && significant(entry.pHolm);
    if (entry.significant) entry.mde = null;
  });
}

export interface ArmCost {
  arm: string;
  n: number;
  usdMedian: number | null;
  usdP90: number | null;
  usdTotal: number;
  tokens: number;
  seconds: number;
  successes: number;
  costPerSuccess: Range;
}

/** Cost over all the arm's paired cases; a case the success metric does not score counts as no success. */
export function armCost(ctx: TrackContext, arm: string, success: Metric): ArmCost {
  const cells = armCells(ctx, arm);
  const usd = cells.map((cell) => cell.listUsd);
  const wins = cells.map((cell) => success(cell) ?? 0);
  const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
  return {
    arm,
    n: cells.length,
    usdMedian: quantile(usd, 0.5),
    usdP90: quantile(usd, 0.9),
    usdTotal: sum(usd),
    tokens: sum(cells.map((cell) => cell.tokens)),
    seconds: sum(cells.map((cell) => cell.seconds)),
    successes: sum(wins),
    costPerSuccess: costPerSuccess(usd, wins, `${ctx.track}:${arm}`),
  };
}
