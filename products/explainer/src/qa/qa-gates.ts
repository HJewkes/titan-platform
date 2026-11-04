import type { Check } from "../workflow/records.js";
import { CAPTIONS_GATE, CONTRAST_GATE, FLASH_GATE, NARRATION_FACTS_GATE } from "./gate-profile.js";
import {
  captionVerdict, chartMarkContrastVerdict, directionVerdict, flashVerdict, heldErrorsVerdict, measuredVerdict, mediaScanVerdict, mp4DurationVerdict, narrationFactsVerdict,
  textContrastVerdict, timingVerdict, timingWarnVerdict,
} from "./qa-checks.js";

interface QaGateInput {
  artifacts: Readonly<Record<string, string>>;
  store: { readText(sha: string): string };
}

/** One check over `qa.json`; a `gate` fails the stage that runs it. */
interface QaGateRow {
  name: string;
  gate: boolean;
  reads: readonly ["qa"];
  run: (input: QaGateInput) => Pick<Check, "pass" | "detail">;
}

/** The qa stage's checks, which render runs over its own qa.json too, so render refuses what the qa stage would. */
export const QA_GATE_ROWS: readonly QaGateRow[] = [
  { name: "held-errors", gate: true, reads: ["qa"], run: heldErrorsVerdict },
  { name: "mp4-duration", gate: true, reads: ["qa"], run: mp4DurationVerdict },
  { name: "motion-happened", gate: true, reads: ["qa"], run: measuredVerdict("motion-happened") },
  { name: "clipped-text", gate: true, reads: ["qa"], run: measuredVerdict("clipped-text") },
  { name: "content-fill", gate: true, reads: ["qa"], run: measuredVerdict("content-fill") },
  { name: "stage-empty", gate: false, reads: ["qa"], run: measuredVerdict("stage-empty") },
  { name: "picture-change", gate: true, reads: ["qa"], run: timingVerdict("picture-change") },
  { name: "picture-change-warn", gate: false, reads: ["qa"], run: timingWarnVerdict("picture-change") },
  { name: "static-window", gate: true, reads: ["qa"], run: timingVerdict("static-window") },
  { name: "cue-onset", gate: true, reads: ["qa"], run: timingVerdict("cue-onset") },
  { name: "reading-hold", gate: true, reads: ["qa"], run: timingVerdict("reading-hold") },
  { name: "headline-label-words", gate: true, reads: ["qa"], run: timingVerdict("G9") },
  { name: "narration-shared-run", gate: true, reads: ["qa"], run: timingVerdict("G10") },
  { name: "words-per-frame", gate: true, reads: ["qa"], run: timingVerdict("words-per-frame") },
  { name: "direction-gates", gate: false, reads: ["qa"], run: directionVerdict },
  { name: "black-frames", gate: false, reads: ["qa"], run: mediaScanVerdict("black", "black stretch") },
  { name: "silence-2s", gate: false, reads: ["qa"], run: mediaScanVerdict("silence", "silence of 2 s or more") },
  { name: "frozen-frames", gate: false, reads: ["qa"], run: mediaScanVerdict("freeze", "frozen stretch") },
  { name: "captions-complete", gate: CAPTIONS_GATE, reads: ["qa"], run: captionVerdict("complete") },
  { name: "captions-words", gate: CAPTIONS_GATE, reads: ["qa"], run: captionVerdict("words") },
  { name: "captions-lines", gate: CAPTIONS_GATE, reads: ["qa"], run: captionVerdict("lines") },
  { name: "captions-cps", gate: CAPTIONS_GATE, reads: ["qa"], run: captionVerdict("cps") },
  { name: "captions-onset", gate: CAPTIONS_GATE, reads: ["qa"], run: captionVerdict("onset") },
  { name: "narration-facts", gate: NARRATION_FACTS_GATE, reads: ["qa"], run: narrationFactsVerdict },
  { name: "photosensitive-flash", gate: FLASH_GATE, reads: ["qa"], run: flashVerdict },
  { name: "text-contrast", gate: CONTRAST_GATE, reads: ["qa"], run: textContrastVerdict },
  { name: "chart-mark-contrast", gate: CONTRAST_GATE, reads: ["qa"], run: chartMarkContrastVerdict },
];

const QA_SHA = "qa";

function rowVerdict(row: QaGateRow, input: QaGateInput): Pick<Check, "pass" | "detail"> {
  try {
    return row.run(input);
  } catch (error) {
    return { pass: false, detail: `could not run: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200)}` };
  }
}

/** Every qa gate row over one `qa.json` text, as the qa stage's checks step would report them. */
export function qaGateChecks(qaJson: string): Check[] {
  const input: QaGateInput = { artifacts: { qa: QA_SHA }, store: { readText: () => qaJson } };
  return QA_GATE_ROWS.map((row) => ({ name: row.name, gate: row.gate, ...rowVerdict(row, input) }));
}
