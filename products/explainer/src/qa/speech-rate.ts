import { z } from "zod";

/** Past this many words a minute a beat is too fast to follow (content standards synthesis §4). */
export const BEAT_MAX_WPM = 250;
/** A video's overall rate outside this band reads as dragging or rushed. */
export const OVERALL_WPM_BAND = { min: 150, max: 190 } as const;

export const SpeechRateReportSchema = z.object({
  /** Words over heard seconds across every voiced beat; null when nothing is voiced. */
  overallWpm: z.number().nullable(),
  overallInBand: z.boolean(),
  beats: z.array(z.object({ beat: z.string(), words: z.number().int().nonnegative(), durationS: z.number(), wpm: z.number().nullable(), fast: z.boolean() })),
  fastBeats: z.array(z.string()),
});
export type SpeechRateReport = z.infer<typeof SpeechRateReportSchema>;

/** A beat's narration as the pipeline already has it: its word count and its heard length. */
export interface SpokenBeat {
  id: string;
  words: number;
  durationS: number;
}

const rate = (words: number, durationS: number): number | null => (durationS > 0 ? (words * 60) / durationS : null);
const round1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);

/** Measured speech rate per beat and overall; a beat with no duration has no rate and is never flagged. */
export function speechRateReport(spoken: readonly SpokenBeat[]): SpeechRateReport {
  const beats = spoken.map(({ id, words, durationS }) => {
    const wpm = rate(words, durationS);
    return { beat: id, words, durationS, wpm: round1(wpm), fast: wpm !== null && wpm > BEAT_MAX_WPM };
  });
  const timed = spoken.filter((beat) => beat.durationS > 0);
  const overall = rate(timed.reduce((sum, beat) => sum + beat.words, 0), timed.reduce((sum, beat) => sum + beat.durationS, 0));
  return {
    overallWpm: round1(overall),
    overallInBand: overall !== null && overall >= OVERALL_WPM_BAND.min && overall <= OVERALL_WPM_BAND.max,
    beats,
    fastBeats: beats.filter((beat) => beat.fast).map((beat) => beat.beat),
  };
}

/** The one-line speech-rate verdict the qa notes lead with. */
export function speechRateSummary(report: SpeechRateReport): string {
  if (report.overallWpm === null) return "speech rate: no voiced beats";
  const band = `${OVERALL_WPM_BAND.min}-${OVERALL_WPM_BAND.max}`;
  const overall = `${report.overallWpm} wpm overall (${report.overallInBand ? "in" : "OUTSIDE"} ${band})`;
  const fast = report.fastBeats.length === 0 ? `no beat over ${BEAT_MAX_WPM} wpm` : `${report.fastBeats.length} beats over ${BEAT_MAX_WPM} wpm (${report.fastBeats.join(", ")})`;
  return `speech rate: ${overall}; ${fast}`;
}
