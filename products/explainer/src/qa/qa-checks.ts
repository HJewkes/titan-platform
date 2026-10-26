import type { Check } from "../workflow/records.js";
import { QaReportSchema, qaSummary, type QaReport } from "./qa-report.js";

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
