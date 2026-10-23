/** Silence before and after a beat's speech; the defaults are the ported bridge's (`gen_audio.py`), so lengths compare one to one. */
export interface Padding {
  leadS: number;
  tailS: number;
}

export const DEFAULT_PADDING: Padding = { leadS: 0.3, tailS: 0.6 };
export const FPS = 30;

/**
 * A beat lasts its planned length, or longer when the voice needs it: the lead, the speech and the tail, rounded up to
 * a whole frame so the page and the audio mix cut on the same frame.
 */
export function trueDuration(plannedS: number, speechS: number, padding: Padding = DEFAULT_PADDING): number {
  const need = Math.max(plannedS, padding.leadS + speechS + padding.tailS);
  return Math.ceil(need * FPS - 1e-9) / FPS;
}

export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

const millis = (s: number): number => Math.round(s * 1000) / 1000;

export const shiftWords = (words: readonly TimedWord[], byS: number): TimedWord[] =>
  words.map((w) => ({ word: w.word, start: millis(w.start + byS), end: millis(w.end + byS) }));

/** Each beat's start on the video timeline: the sum of the trued lengths before it. */
export function beatStarts(durations: readonly number[]): number[] {
  let at = 0;
  return durations.map((d) => {
    const start = millis(at);
    at += d;
    return start;
  });
}
