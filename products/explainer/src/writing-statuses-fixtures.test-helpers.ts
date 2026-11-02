import { afterAll, beforeAll } from "vitest";
import { overrideStatusTable, type StatusTable } from "./writing-statuses.js";

const ROWS = [
  "numbers", "second-person", "we", "sentence-mean", "sentence-cv", "contractions",
  "triads", "colon-reveals", "not-x-tails", "semicolons", "lets", "phrases", "neg-synthetic", "downtoners",
] as const;

/** The statuses Q-V11 acted on before TP-4662, at any length from 150 words: every row warns but downtoners. */
const PRE_CALIBRATION: StatusTable = {
  meta: { buckets: [{ name: "any", lo: 150, hi: null }] },
  statusByBucket: Object.fromEntries(ROWS.map((row) => [row, { any: row === "downtoners" ? "report-only" : "warning" }])),
};

/**
 * Runs the calling file under the pre-calibration statuses and restores the shipped table after it. The explainer
 * project shares one module graph per worker, so a file-level override must be undone, never left for the next file.
 */
export function usePreCalibrationStatuses(): void {
  beforeAll(() => overrideStatusTable(PRE_CALIBRATION));
  afterAll(() => overrideStatusTable(undefined));
}
