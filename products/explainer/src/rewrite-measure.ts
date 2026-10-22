import { MAX_CROWDED_BEAT_SHARE, REGISTER_BANDS, type Band } from "./lint-register.js";
import { REWRITE_TARGET_ROWS } from "./rewrite-plan.js";
import type { TargetRow } from "./rewrite-pass.js";

export type TargetRowId = (typeof REWRITE_TARGET_ROWS)[number];

/** One input's target rows before the pass, and after it on each sample that finished. */
export interface MeasureInput {
  name: string;
  before: readonly TargetRow[];
  samples: readonly (readonly TargetRow[])[];
}

/** One input and row over its samples; `sd` is the sample standard deviation, undefined under 2 samples. */
export interface MeasureCell {
  input: string;
  row: TargetRowId;
  band: Band;
  before: number;
  mean: number;
  sd?: number;
  n: number;
  inBand: boolean;
  /** In band, or nearer to it than before. */
  closer: boolean;
  /** The mean sits further from the band edge than its 90% one-sided noise, so a further sample would not flip it. */
  decided: boolean;
  reportOnly: boolean;
}

/** One row over the inputs, under the revised done-when: every input closer, and the mean in band or within 1σ. */
export interface MeasureRow {
  row: TargetRowId;
  band: Band;
  mean: number;
  /** One sample's noise, pooled over the inputs' per-cell variances; undefined when no cell has 2 samples. */
  sigma?: number;
  inBand: boolean;
  withinSigma: boolean;
  everyInputCloser: boolean;
  pass: boolean;
}

export interface MeasureSummary {
  cells: MeasureCell[];
  rows: MeasureRow[];
  pass: boolean;
}

const TARGET_BANDS: Record<TargetRowId, Band> = {
  "register:numbers": REGISTER_BANDS.numbers,
  "register:numbers-per-beat": { max: MAX_CROWDED_BEAT_SHARE },
  "register:triads": REGISTER_BANDS.triads,
  "register:sentence-mean": REGISTER_BANDS["sentence-mean"],
  "register:sentence-cv": REGISTER_BANDS["sentence-cv"],
};

// One-sided 90% Student t quantiles by degrees of freedom; past 10 the normal quantile is close enough.
const T90 = [Infinity, 3.078, 1.886, 1.638, 1.533, 1.476, 1.44, 1.415, 1.397, 1.383, 1.372];
const t90 = (df: number): number => T90[df] ?? 1.282;

const mean = (xs: readonly number[]): number => xs.reduce((sum, x) => sum + x, 0) / xs.length;
const variance = (xs: readonly number[]): number => {
  const m = mean(xs);
  return xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1);
};

/** How far a value sits outside the band; zero inside it. */
export const bandGap = (value: number, band: Band): number => Math.max(0, (band.min ?? -Infinity) - value, value - band.max);

/** Distance to the nearest band edge, positive inside the band and negative outside. */
const edgeMargin = (value: number, band: Band): number =>
  bandGap(value, band) > 0 ? -bandGap(value, band) : Math.min(value - (band.min ?? -Infinity), band.max - value);

const rowValue = (rows: readonly TargetRow[], row: TargetRowId): number | undefined => rows.find((r) => r.check_id === row)?.value;

function measureCell(input: MeasureInput, row: TargetRowId, reportOnly: boolean): MeasureCell | undefined {
  const before = rowValue(input.before, row);
  const values = input.samples.map((sample) => rowValue(sample, row)).filter((value) => value !== undefined);
  if (before === undefined || values.length === 0) return undefined;
  const band = TARGET_BANDS[row];
  const m = mean(values);
  const sd = values.length > 1 ? Math.sqrt(variance(values)) : undefined;
  const inBand = bandGap(m, band) === 0;
  const noise = sd === undefined ? Infinity : (t90(values.length - 1) * sd) / Math.sqrt(values.length);
  return {
    input: input.name, row, band, before, mean: m, ...(sd === undefined ? {} : { sd }), n: values.length,
    inBand, closer: inBand || bandGap(m, band) < bandGap(before, band), decided: Math.abs(edgeMargin(m, band)) > noise, reportOnly,
  };
}

function measureRow(row: TargetRowId, cells: readonly MeasureCell[]): MeasureRow {
  const band = TARGET_BANDS[row];
  const m = mean(cells.map((cell) => cell.mean));
  const spread = cells.flatMap((cell) => (cell.sd === undefined ? [] : [cell.sd ** 2]));
  const sigma = spread.length > 0 ? Math.sqrt(mean(spread)) : undefined;
  const inBand = bandGap(m, band) === 0;
  const withinSigma = inBand || (sigma !== undefined && bandGap(m, band) <= sigma);
  const everyInputCloser = cells.every((cell) => cell.reportOnly || cell.closer);
  return { row, band, mean: m, ...(sigma === undefined ? {} : { sigma }), inBand, withinSigma, everyInputCloser, pass: withinSigma && everyInputCloser };
}

/**
 * Scores a multi-sample rewrite measure under the revised done-when. A report-only cell (`input:row`) still counts
 * toward its row's mean, but its own input need not move closer.
 */
export function summarizeMeasure(inputs: readonly MeasureInput[], reportOnly: ReadonlySet<string> = new Set()): MeasureSummary {
  const cells = REWRITE_TARGET_ROWS.flatMap((row) =>
    inputs.flatMap((input) => measureCell(input, row, reportOnly.has(`${input.name}:${row}`)) ?? []));
  const rows = REWRITE_TARGET_ROWS.map((row) => cells.filter((cell) => cell.row === row)).filter((rowCells) => rowCells.length > 0)
    .map((rowCells) => measureRow(rowCells[0]!.row, rowCells));
  return { cells, rows, pass: rows.length === REWRITE_TARGET_ROWS.length && rows.every((row) => row.pass) };
}

const SHARE_ROW: TargetRowId = "register:numbers-per-beat";
const shown = (row: TargetRowId, value: number): string => (row === SHARE_ROW ? `${(100 * value).toFixed(1)}%` : value.toFixed(row === "register:sentence-cv" ? 3 : 2));
const bandText = (row: TargetRowId, band: Band): string =>
  band.min === undefined || row === "register:numbers" ? `<= ${shown(row, band.max)}` : `>= ${shown(row, band.min)}`;
const yes = (flag: boolean): string => (flag ? "yes" : "no");

function cellLine(cell: MeasureCell): string {
  const spread = cell.sd === undefined ? "" : ` ± ${shown(cell.row, cell.sd)}`;
  const decided = cell.decided ? (cell.inBand ? "in band" : "out of band") : "within noise";
  return `| ${cell.input} | ${cell.row}${cell.reportOnly ? " (report-only)" : ""} | ${bandText(cell.row, cell.band)} | ${shown(cell.row, cell.before)} | ` +
    `${shown(cell.row, cell.mean)}${spread} | ${cell.n} | ${yes(cell.inBand)} | ${yes(cell.closer)} | ${decided} |`;
}

function rowLine(row: MeasureRow): string {
  const sigma = row.sigma === undefined ? "n/a" : shown(row.row, row.sigma);
  return `| ${row.row} | ${bandText(row.row, row.band)} | ${shown(row.row, row.mean)} | ${sigma} | ${yes(row.inBand)} | ${yes(row.withinSigma)} | ` +
    `${yes(row.everyInputCloser)} | ${row.pass ? "PASS" : "FAIL"} |`;
}

/** The measure as two markdown tables: each input and row, then each row over the inputs with its verdict. */
export function measureTable(summary: MeasureSummary): string {
  return [
    "| input | row | band | before | mean ± sd | n | in band | closer | decided |",
    "|---|---|---|---|---|---|---|---|---|",
    ...summary.cells.map(cellLine),
    "",
    "| row | band | mean over inputs | σ (one sample) | in band | within 1σ | every input closer | verdict |",
    "|---|---|---|---|---|---|---|---|",
    ...summary.rows.map(rowLine),
    "",
    `Revised done-when: ${summary.pass ? "PASS" : "FAIL"}`,
    "",
  ].join("\n");
}
