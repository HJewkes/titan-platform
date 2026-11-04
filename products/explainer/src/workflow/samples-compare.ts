import { bandGap, type MeasureSummary, type TargetRowId } from "../rewrite-measure.js";
import type { Band } from "../lint-register.js";

/** One sample's noise per target row, as an A/A floor measures it. */
export type NoiseFloor = Partial<Record<TargetRowId, number>>;

/**
 * `noise`: the arms differ by no more than the noise band. `win` / `loss`: B's mean sits nearer to / further from the
 * band than A's. `shift`: a difference past the band with both means equally near it (both in band). `unknown`: no
 * σ to judge by, as with one sample per arm and no floor.
 */
export type ArmVerdict = "noise" | "win" | "loss" | "shift" | "unknown";

export interface RowCompare {
  row: TargetRowId;
  band: Band;
  meanA: number;
  meanB: number;
  diff: number;
  sigma?: number;
  /** Where the floor σ came from: the A/A floor, or the two arms' own pooled σ. */
  sigmaFrom?: "floor" | "arms";
  verdict: ArmVerdict;
}

/** ar's band: a difference of more than 2σ of one sample's noise is a real difference (workflow plan §5.3). */
export const NOISE_SIGMAS = 2;

const pooled = (sigmas: readonly (number | undefined)[]): number | undefined => {
  const known = sigmas.filter((sigma) => sigma !== undefined);
  return known.length === 0 ? undefined : Math.sqrt(known.reduce((sum, sigma) => sum + sigma ** 2, 0) / known.length);
};

/** Judges one row's difference between the arms against σ; inside the band it is noise, whichever way it points. */
export function armVerdict(band: Band, meanA: number, meanB: number, sigma: number | undefined): ArmVerdict {
  if (sigma === undefined) return "unknown";
  if (Math.abs(meanB - meanA) <= NOISE_SIGMAS * sigma) return "noise";
  const nearer = bandGap(meanA, band) - bandGap(meanB, band);
  return nearer > 0 ? "win" : nearer < 0 ? "loss" : "shift";
}

/** Each target row both arms measured, B against A; σ is the floor's when it has the row, else the arms' pooled σ. */
export function compareArms(a: MeasureSummary, b: MeasureSummary, floor: NoiseFloor = {}): RowCompare[] {
  return a.rows.flatMap((rowA) => {
    const rowB = b.rows.find((row) => row.row === rowA.row);
    if (!rowB) return [];
    const fromFloor = floor[rowA.row];
    const sigma = fromFloor ?? pooled([rowA.sigma, rowB.sigma]);
    const from = fromFloor !== undefined ? { sigmaFrom: "floor" as const } : sigma === undefined ? {} : { sigmaFrom: "arms" as const };
    return [{
      row: rowA.row, band: rowA.band, meanA: rowA.mean, meanB: rowB.mean, diff: rowB.mean - rowA.mean,
      ...(sigma === undefined ? {} : { sigma }), ...from, verdict: armVerdict(rowA.band, rowA.mean, rowB.mean, sigma),
    }];
  });
}

const num = (value: number): string => value.toFixed(3);

/** The comparison as a markdown table, one row per target row. */
export function compareTable(rows: readonly RowCompare[], labels: { a: string; b: string }): string {
  return [
    `| row | ${labels.a} mean | ${labels.b} mean | diff | σ | ${NOISE_SIGMAS}σ band | verdict |`,
    "|---|---|---|---|---|---|---|",
    ...rows.map((row) => {
      const sigma = row.sigma === undefined ? "n/a" : `${num(row.sigma)} (${row.sigmaFrom})`;
      const band = row.sigma === undefined ? "n/a" : `± ${num(NOISE_SIGMAS * row.sigma)}`;
      return `| ${row.row} | ${num(row.meanA)} | ${num(row.meanB)} | ${row.diff >= 0 ? "+" : ""}${num(row.diff)} | ${sigma} | ${band} | ${row.verdict} |`;
    }),
    "",
  ].join("\n");
}
