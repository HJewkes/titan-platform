/**
 * The settled-speech excusal static-window and Q-D22 share (TP-4574, owner decision vc-6). A frame whose beat has
 * revealed every element it draws is a finished picture, and while the narration speaks over it the viewer is
 * listening, not waiting, so it may stand still past `pacing.staticMaxS`, up to `SETTLED_SPEECH_MAX_S`. A frame still
 * waiting on an element is not excused, and neither is silence: the part of the run the voice does not cover still
 * keeps to `staticMaxS`.
 */

/** The longest still run of a settled frame the narration speaks over. */
export const SETTLED_SPEECH_MAX_S = 6;

const EPS = 1e-9;

interface Span {
  fromS: number;
  toS: number;
}

/** A beat's settled picture and its speech, on one clock: from its last reveal to its end, and its first to last word. */
export interface SettledSpeech {
  settled: Span;
  speech: Span;
}

const overlapS = (a: Span, b: Span): number => Math.max(0, Math.min(a.toS, b.toS) - Math.max(a.fromS, b.fromS));

/** Whether a still run past staticMaxS is excused: wholly settled, at most SETTLED_SPEECH_MAX_S, silent at most staticMaxS. */
export function settledSpeechExcuses(run: Span, beat: SettledSpeech | undefined, staticMaxS: number): boolean {
  if (!beat) return false;
  const lengthS = run.toS - run.fromS;
  const settled = run.fromS >= beat.settled.fromS - EPS && run.toS <= beat.settled.toS + EPS;
  return settled && lengthS <= SETTLED_SPEECH_MAX_S + EPS && lengthS - overlapS(run, beat.speech) <= staticMaxS + EPS;
}
