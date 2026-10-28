import type { CaptionRule } from "./caption-check.js";
import type { Check } from "../workflow/records.js";
import { MAX_FLASHES_PER_S, type FlashReport } from "./flash-scan.js";
import { QaReportSchema, qaSummary, type MediaScanReport, type QaReport } from "./qa-report.js";
import { TIMING_GATES, type TimingGate } from "./timing-gates.js";

type Verdict = Pick<Check, "pass" | "detail">;

interface QaCheckInput {
  artifacts: Readonly<Record<string, string>>;
  store: { readText(sha: string): string };
}

const report = (input: QaCheckInput): QaReport => QaReportSchema.parse(JSON.parse(input.store.readText(input.artifacts.qa!)));

/** A held error fails the stage, so the run stops before sheets; the detail is the per-kind summary. */
export function heldErrorsVerdict(input: QaCheckInput): Verdict {
  const qa = report(input);
  return { pass: qa.errors.length === 0, detail: qaSummary(qa) };
}

/** The MP4 plays as long as the timeline QA inspected, to within one frame; longer or shorter, QA saw a different video. */
export function mp4DurationVerdict(input: QaCheckInput): Verdict {
  const { durationS, timelineS, frameS } = report(input).mp4;
  const offS = Math.abs(durationS - timelineS);
  return { pass: offS <= frameS, detail: `mp4 ${durationS.toFixed(3)} s, timeline ${timelineS.toFixed(3)} s: off by ${offS.toFixed(3)} s (at most ${frameS.toFixed(3)})` };
}

/** Shown in a measured check's detail; the rest are in `qa.json`. */
const DETAIL_FINDINGS = 3;

/** The page-measured findings of one code: none passes; the detail quotes the first few with their anchor cells. */
export const measuredVerdict = (code: string) => (input: QaCheckInput): Verdict => {
  const found = report(input).measured.filter((finding) => finding.code === code);
  const shown = found.slice(0, DETAIL_FINDINGS).map(({ anchors, message }) => (anchors.length > 0 ? `[${anchors.join(",")}] ${message}` : message)).join("; ");
  return { pass: found.length === 0, detail: found.length === 0 ? `no ${code} finding` : `${found.length} ${code}: ${shown}` };
};

const timingGate = (input: QaCheckInput, id: string) => report(input).timing.gates.find((gate) => gate.id === id);

const gateDetail = ({ id, value, threshold, beats }: TimingGate): string => `${id} ${value ?? "n/a"} (${threshold})${beats.length > 0 ? `: ${beats.join(", ")}` : ""}`;

/** One timing gate's verdict; a gate qa.json does not carry fails, as a qa.json from before the gate would. */
export const timingVerdict = (id: string) => (input: QaCheckInput): Verdict => {
  const gate = timingGate(input, id);
  return gate === undefined ? { pass: false, detail: `qa.json has no ${id} timing gate` } : { pass: gate.pass, detail: gateDetail(gate) };
};

/** A gate's warn line, read as its own reported check. */
export const timingWarnVerdict = (id: string) => (input: QaCheckInput): Verdict => {
  const gate = timingGate(input, id);
  return gate === undefined ? { pass: false, detail: `qa.json has no ${id} timing gate` } : { pass: gate.warn !== true, detail: gateDetail(gate) };
};

/** The ported spike gates (G1-G13), reported together until one is promoted to a gate of its own. */
export function directionVerdict(input: QaCheckInput): Verdict {
  const ported = report(input).timing.gates.filter((gate) => !TIMING_GATES.includes(gate.id));
  const failed = ported.filter((gate) => !gate.pass);
  return { pass: failed.length === 0, detail: `${ported.length - failed.length}/${ported.length} pass${failed.length > 0 ? `; ${failed.map(gateDetail).join("; ")}` : ""}` };
}

/** One media scan's intervals, reported: none passes; the detail names each stretch's span and beats. */
export const mediaScanVerdict = (kind: keyof MediaScanReport, label: string) => (input: QaCheckInput): Verdict => {
  const found = report(input).mediaScan[kind];
  const shown = found.slice(0, DETAIL_FINDINGS).map(({ startS, endS, beats }) => `${startS.toFixed(2)}-${endS.toFixed(2)} s [${beats.join(",")}]`).join("; ");
  return { pass: found.length === 0, detail: found.length === 0 ? `no ${label}` : `${found.length} ${label}: ${shown}` };
};

/** One caption rule's findings: none passes; a qa.json from before the caption check fails, as a missing gate does. */
export const captionVerdict = (rule: CaptionRule) => (input: QaCheckInput): Verdict => {
  const { captions } = report(input);
  if (captions === undefined) return { pass: false, detail: "qa.json has no captions report" };
  const found = captions.findings.filter((finding) => finding.rule === rule);
  const shown = found.slice(0, DETAIL_FINDINGS).map((finding) => finding.message).join("; ");
  return { pass: found.length === 0, detail: found.length === 0 ? `${captions.cues} cues, no ${rule} finding` : `${found.length} caption ${rule}: ${shown}` };
};

const flashDetail = (label: string, { maxPerS, windows }: FlashReport["general"]): string =>
  `${label} ${maxPerS}/s${windows.length > 0 ? ` over ${MAX_FLASHES_PER_S} at ${windows.slice(0, DETAIL_FINDINGS).map(({ startS, endS }) => `${startS.toFixed(2)}-${endS.toFixed(2)} s`).join(", ")}` : ""}`;

/** WCAG 2.3.1: more than three general or red flashes in any one second fails; a qa.json from before the scan fails. */
export function flashVerdict(input: QaCheckInput): Verdict {
  const { flash } = report(input);
  if (flash === undefined) return { pass: false, detail: "qa.json has no flash scan" };
  const pass = flash.general.windows.length === 0 && flash.red.windows.length === 0;
  return { pass, detail: `${flashDetail("general", flash.general)}; ${flashDetail("red", flash.red)} (${flash.method})` };
}
