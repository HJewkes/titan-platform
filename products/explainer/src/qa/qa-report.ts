import { countByKind, type Held, type HeldFinding, type MediaInterval, type MediaScan } from "@titan-design/render-qa";
import { z } from "zod";
import { CaptionReportSchema } from "./caption-check.js";
import { FlashReportSchema } from "./flash-scan.js";
import { NarrationFactsReportSchema } from "./narration-facts.js";
import type { QaTimeline } from "./qa-timeline.js";
import { TIMING_GATES } from "./timing-gates.js";

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
type QaFinding = z.infer<typeof QaFindingSchema>;

const ProbeBoxSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

/** render-qa's probe at one sampled moment: every visible text run with its lines and clipping ancestors, and every content box. */
const ProbedMomentSchema = z.object({
  beat: z.string(),
  t: z.number(),
  texts: z.array(
    z.object({
      text: z.string(), px: z.number(), tag: z.string(), cls: z.string(), element: z.string(),
      lines: z.array(ProbeBoxSchema), clips: z.array(z.object({ element: z.string(), box: ProbeBoxSchema })),
    }),
  ),
  boxes: z.array(z.object({ element: z.string(), box: ProbeBoxSchema, decor: z.boolean().optional() })),
});

/** A page-measured finding (motion, clipped text, content fill, empty stage) by beat and the anchor cells it sits on. */
const MeasuredFindingSchema = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning"]),
  beat: z.string(),
  t: z.number().optional(),
  anchors: z.array(z.string()),
  /** The check's own message, which leads with the beat. */
  message: z.string(),
});
export type MeasuredFinding = z.infer<typeof MeasuredFindingSchema>;

const TimingGateSchema = z.object({
  id: z.string(), value: z.number().nullable(), threshold: z.string(), pass: z.boolean(), warn: z.boolean().optional(), beats: z.array(z.string()),
});

/** The DIRECTION timing gates (`timing-gates.ts`), and the two counts ar target 3 reads (TP-4033). */
const TimingSchema = z.object({ gates: z.array(TimingGateSchema), static_window_count: z.number().int().nonnegative(), picture_change_gap_max: z.number() });

const MediaIntervalSchema = z.object({ startS: z.number(), endS: z.number(), beats: z.array(z.string()) });

/** render-qa's `mediaScan` of the MP4, each interval with the beats it overlaps; reported only. */
const MediaScanSchema = z.object({ black: z.array(MediaIntervalSchema), silence: z.array(MediaIntervalSchema), freeze: z.array(MediaIntervalSchema) });
export type MediaScanReport = z.infer<typeof MediaScanSchema>;

/** The measured codes that fail the stage; `stage-empty` is reported only. */
const MEASURED_GATES: readonly string[] = ["motion-happened", "clipped-text", "content-fill"];

/** Past this many bytes a series goes to its own artifact and qa.json keeps the sha, so qa.json stays small to read. */
export const INLINE_MAX_BYTES = 64 * 1024;

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
  /** Whether the 2 Hz sweep joined the cue moments (variant param `sweep`, on unless set false). */
  sweep: z.boolean(),
  /** The MP4's per-frame changed share (render-qa `frameDiffs`), inline or as the `framediff` artifact's sha. */
  framediff: z.union([z.strictObject({ fps: z.number(), shares: z.array(z.number()) }), z.strictObject({ fps: z.number(), artifact: z.string() })]),
  /** The probe at every sampled moment, in time order, inline or as the `qa-probe` artifact's sha. */
  probe: z.union([z.strictObject({ moments: z.array(ProbedMomentSchema) }), z.strictObject({ artifact: z.string() })]),
  measured: z.array(MeasuredFindingSchema),
  timing: TimingSchema,
  mediaScan: MediaScanSchema,
  /** The caption track against words.json (`caption-check.ts`); absent in a qa.json from before the check. */
  captions: CaptionReportSchema.optional(),
  /** On-screen numbers and headline names the narration never says (`narration-facts.ts`); absent before the check. */
  narrationFacts: NarrationFactsReportSchema.optional(),
  /** General and red flashes per second of the MP4 (`flash-scan.ts`); absent in a qa.json from before the check. */
  flash: FlashReportSchema.optional(),
  notes: z.array(z.string()),
});
export type QaReport = z.infer<typeof QaReportSchema>;

const finding = (held: HeldFinding & { crop?: string }): QaFinding => ({
  kind: held.kind, beat: held.beat, ts: held.ts, at: held.finding.at, reason: held.reason, el: held.finding.el,
  ...(held.finding.text === undefined ? {} : { text: held.finding.text }), ...(held.crop === undefined ? {} : { crop: held.crop }),
});

type QaReportBase = Omit<QaReport, "schema" | "pass" | "errorCounts" | "infoCounts" | "errors" | "info">;

export function qaReport(held: Held, base: QaReportBase): QaReport {
  const gated = base.measured.some((finding) => MEASURED_GATES.includes(finding.code)) || base.timing.gates.some((gate) => TIMING_GATES.includes(gate.id) && !gate.pass);
  return {
    schema: "explainer.qa/v1", pass: held.errors.length === 0 && !gated, ...base,
    errorCounts: countByKind(held.errors), infoCounts: countByKind(held.info), errors: held.errors.map(finding), info: held.info.map(finding),
  };
}

const beatsDuring = (timeline: QaTimeline) => ({ startS, endS }: MediaInterval) => ({
  startS, endS, beats: timeline.beats.filter((beat) => beat.startS < endS && beat.startS + beat.durationS > startS).map((beat) => beat.id),
});

/** Names the beats each scanned interval overlaps, so a check can say where the stretch fell. */
export function mediaScanByBeat(scan: MediaScan, timeline: QaTimeline): MediaScanReport {
  const named = beatsDuring(timeline);
  return { black: scan.black.map(named), silence: scan.silence.map(named), freeze: scan.freeze.map(named) };
}

/** The spike `qa.ts` one-line summary, held errors counted by kind; the measured checks give their own. */
export function qaSummary(report: QaReport): string {
  const counts = Object.entries(report.errorCounts).map(([kind, n]) => `${kind} ${n}`).join(", ");
  const held = `${report.errors.length} held errors${counts ? ` (${counts})` : ""}`;
  return `qa ${report.errors.length === 0 ? "PASS" : "FAIL"}: ${held}, ${report.info.length} info, ${report.moments} moments`;
}
