import { z } from "zod";

/** The status rule's cut-offs. They are data in `doctrine/writing-check.json`; `rowStatus` only applies them. */
export const StatusThresholdsSchema = z.strictObject({
  dropAucUpper: z.number(),
  dropFpr: z.number(),
  gateAucLower: z.number(),
  gateFprUpper: z.number(),
  gateFprPoint: z.number(),
  gatePrecision: z.number(),
  gateMinNeg: z.number(),
  gateMinPos: z.number(),
  warnAucLower: z.number(),
  warnFprPoint: z.number(),
});
export type StatusThresholds = z.infer<typeof StatusThresholdsSchema>;

export type WritingStatus = "drop" | "gate" | "warning" | "report-only";

export interface AucContrast {
  lo: number;
  hi: number;
  nPos: number;
}

export interface SpanPrecision {
  correct: number;
  labelled: number;
}

/** A row's held-out numbers in one length bucket. A contrast or FPR the bucket cannot measure is absent. */
export interface RowMetrics {
  oursNew?: AucContrast | undefined;
  aiOther?: AucContrast | undefined;
  fpr?: { n: number; point: number; upper: number } | undefined;
  precision?: SpanPrecision | undefined;
}

export interface RowStatus {
  status: WritingStatus;
  why: string;
  gateMisses: string[];
}

const hundredths = (value: number): string => value.toFixed(2);
const spansHalf = (contrast: AucContrast): boolean => contrast.lo <= 0.5 && contrast.hi >= 0.5;

/** Every gate condition the row fails, worded for the report. */
function gateMisses(m: RowMetrics, t: StatusThresholds): string[] {
  const misses: string[] = [];
  const { oursNew, fpr, precision } = m;
  if (!oursNew || oursNew.lo < t.gateAucLower) misses.push(`AUC lower vs ours-new ${oursNew ? hundredths(oursNew.lo) : "n/a"} < ${hundredths(t.gateAucLower)}`);
  if (!fpr || fpr.upper > t.gateFprUpper) misses.push(`FPR upper ${fpr ? hundredths(fpr.upper) : "n/a"} > ${hundredths(t.gateFprUpper)}`);
  if (!fpr || fpr.point > t.gateFprPoint) misses.push(`FPR point ${fpr ? hundredths(fpr.point) : "n/a"} > ${hundredths(t.gateFprPoint)}`);
  if (!precision) misses.push("span precision not labelled");
  else if (precision.correct / precision.labelled < t.gatePrecision) misses.push(`span precision ${precision.correct}/${precision.labelled} < ${t.gatePrecision}`);
  if (!fpr || fpr.n < t.gateMinNeg) misses.push(`n_neg ${fpr?.n ?? 0} < ${t.gateMinNeg}`);
  if (!oursNew || oursNew.nPos < t.gateMinPos) misses.push(`n_pos ${oursNew?.nPos ?? 0} < ${t.gateMinPos}`);
  return misses;
}

function dropReason(m: RowMetrics, t: StatusThresholds): string | undefined {
  const contrasts = [m.oursNew, m.aiOther].filter((contrast) => contrast !== undefined);
  if (contrasts.length === 0) return undefined;
  if (contrasts.every((contrast) => contrast.hi < t.dropAucUpper)) return `AUC upper bound < ${t.dropAucUpper} on every AI group`;
  if (m.fpr && m.fpr.point > t.dropFpr && contrasts.every(spansHalf)) return `FPR > ${hundredths(t.dropFpr)} and every AUC CI includes 0.5`;
  return undefined;
}

/**
 * The TP-4662 status rule, evaluated in order: drop, gate, warning, report-only. Returns the first rule that decided the
 * row, with the gate conditions it failed so a report can say why a near miss stayed a warning.
 */
export function rowStatus(m: RowMetrics, t: StatusThresholds): RowStatus {
  const dropped = dropReason(m, t);
  if (dropped !== undefined) return { status: "drop", why: dropped, gateMisses: [] };
  const misses = gateMisses(m, t);
  if (misses.length === 0) return { status: "gate", why: "all gate conditions hold", gateMisses: [] };
  const separates = [m.oursNew, m.aiOther].some((contrast) => contrast !== undefined && contrast.lo >= t.warnAucLower);
  if (separates && m.fpr && m.fpr.point <= t.warnFprPoint) {
    return { status: "warning", why: `AUC lower bound >= ${hundredths(t.warnAucLower)} on ours-new or ai-other and FPR point <= ${hundredths(t.warnFprPoint)}`, gateMisses: misses };
  }
  return { status: "report-only", why: "no rule above applies", gateMisses: misses };
}
