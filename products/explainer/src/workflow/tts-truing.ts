import { BEAT_SECONDS } from "../lint-flow.js";

/** Silence before and after a beat's speech; the defaults are the ported bridge's (`gen_audio.py`), so lengths compare one to one. */
export interface Padding {
  leadS: number;
  tailS: number;
}

export const DEFAULT_PADDING: Padding = { leadS: 0.3, tailS: 0.6 };
const FPS = 30;
/** How long the picture holds after the tail before the next beat, so the last reveal is seen settled. */
export const SETTLE_S = 1;
const [BEAT_FLOOR_S] = BEAT_SECONDS;

/**
 * A beat lasts what the voice needs: the lead, the speech and the tail, longer than planned when the voice runs long.
 * A voice that runs short ends the beat a settle after its tail, never under the beat floor (or the plan, if that is
 * shorter), so the frame does not sit still on a beat the narration has left. A held beat is still on purpose and
 * keeps its plan. Rounded up to a whole frame so the page and the audio mix cut on the same frame.
 */
export function trueDuration(plannedS: number, speechS: number, padding: Padding = DEFAULT_PADDING, held = false): number {
  const voiced = padding.leadS + speechS + padding.tailS;
  const short = held ? plannedS : Math.max(Math.min(BEAT_FLOOR_S, plannedS), Math.min(plannedS, voiced + SETTLE_S));
  const need = voiced >= plannedS ? voiced : short;
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
