import { countByKind, type Held, type HeldFinding } from "@titan-design/render-qa";
import { z } from "zod";

const RectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

/** A finding by beat, as the repair rounds (TP-2616) read it: where it showed, when, and why it gates or not. */
const QaFindingSchema = z.object({
  kind: z.string(),
  beat: z.string(),
  ts: z.array(z.number()),
  at: RectSchema,
  reason: z.string(),
  el: z.string(),
  text: z.string().optional(),
  /** The annotated crop's file name inside the `qa-crops` tree; absent past render-qa's per-kind cap. */
  crop: z.string().optional(),
});
export type QaFinding = z.infer<typeof QaFindingSchema>;

/** `qa.json`: the qa stage's whole verdict, which its checks read and nothing recomputes. */
export const QaReportSchema = z.object({
  schema: z.literal("explainer.qa/v1"),
  pass: z.boolean(),
  /** The run's video type, whose gate profile override applied; null when the run has no profile. */
  profile: z.string().nullable(),
  gateProfileSha: z.string(),
  gate: z.array(z.string()),
  /** Where the beats and cues came from: the render's `timeline`, or words + script for a bridged render. */
  timeline: z.enum(["timeline", "words"]),
  moments: z.number().int().nonnegative(),
  errorCounts: z.record(z.string(), z.number()),
  infoCounts: z.record(z.string(), z.number()),
  errors: z.array(QaFindingSchema),
  info: z.array(QaFindingSchema),
  mp4: z.object({ durationS: z.number(), timelineS: z.number(), frameS: z.number() }),
  notes: z.array(z.string()),
});
export type QaReport = z.infer<typeof QaReportSchema>;

const finding = (held: HeldFinding & { crop?: string }): QaFinding => ({
  kind: held.kind, beat: held.beat, ts: held.ts, at: held.finding.at, reason: held.reason, el: held.finding.el,
  ...(held.finding.text === undefined ? {} : { text: held.finding.text }), ...(held.crop === undefined ? {} : { crop: held.crop }),
});

export type QaReportBase = Omit<QaReport, "schema" | "pass" | "errorCounts" | "infoCounts" | "errors" | "info">;

export function qaReport(held: Held, base: QaReportBase): QaReport {
  return {
    schema: "explainer.qa/v1", pass: held.errors.length === 0, ...base,
    errorCounts: countByKind(held.errors), infoCounts: countByKind(held.info), errors: held.errors.map(finding), info: held.info.map(finding),
  };
}

/** The spike `qa.ts` one-line summary, held errors counted by kind. */
export function qaSummary(report: QaReport): string {
  const counts = Object.entries(report.errorCounts).map(([kind, n]) => `${kind} ${n}`).join(", ");
  const held = `${report.errors.length} held errors${counts ? ` (${counts})` : ""}`;
  return `qa ${report.pass ? "PASS" : "FAIL"}: ${held}, ${report.info.length} info, ${report.moments} moments`;
}
