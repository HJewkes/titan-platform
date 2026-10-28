import type { CaptionRule } from "./caption-check.js";
import type { Check } from "../workflow/records.js";
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

/** On-screen facts the narration never says: none passes; a qa.json from before the check fails, as a missing gate does. */
export function narrationFactsVerdict(input: QaCheckInput): Verdict {
  const { narrationFacts } = report(input);
  if (narrationFacts === undefined) return { pass: false, detail: "qa.json has no narrationFacts report" };
  const { beats, findings } = narrationFacts;
  const shown = findings.slice(0, DETAIL_FINDINGS).map(({ beat, kind, fact }) => `[${beat}] ${kind} "${fact}"`).join("; ");
  return { pass: findings.length === 0, detail: findings.length === 0 ? `${beats} beats, every on-screen fact narrated` : `${findings.length} unspoken: ${shown}` };
}

/** Text runs under the WCAG text ratios: none passes; a qa.json from before the check fails, as a missing gate does. */
export function textContrastVerdict(input: QaCheckInput): Verdict {
  const { contrast } = report(input);
  if (contrast === undefined) return { pass: false, detail: "qa.json has no contrast report" };
  const { below } = contrast.text;
  const shown = below.slice(0, DETAIL_FINDINGS).map(({ beat, text, px, ratio, need }) => `[${beat}] "${text}" ${px} px ${ratio}:1 (needs ${need}:1)`).join("; ");
  return { pass: below.length === 0, detail: below.length === 0 ? "no text under the contrast thresholds" : `${below.length} text runs under contrast: ${shown}` };
}

/** Chart marks under the non-text ratio against their ground: none passes; a qa.json from before the check fails. */
export function chartMarkContrastVerdict(input: QaCheckInput): Verdict {
  const { contrast } = report(input);
  if (contrast === undefined) return { pass: false, detail: "qa.json has no contrast report" };
  const { checked, below } = contrast.marks;
  const shown = below.slice(0, DETAIL_FINDINGS).map(({ beat, mark, colour, ground, ratio }) => `[${beat}] ${mark} ${colour} on ${ground} ${ratio.toFixed(2)}:1`).join("; ");
  const need = contrast.thresholds.nonText;
  return { pass: below.length === 0, detail: below.length === 0 ? `${checked} chart marks at ${need}:1 or more` : `${below.length}/${checked} chart marks under ${need}:1: ${shown}` };
}
