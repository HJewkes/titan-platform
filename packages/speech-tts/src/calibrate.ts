import { TtsFailedError } from "./errors.js";
import { speakingSeconds } from "./speaking.js";
import type { Synthesis, TtsInput, TtsProvider } from "./types.js";

export interface CalibrateOptions {
  targetWpm: number;
  /** Words in the spoken text. The caller counts them: plain-text rules belong to the caller. */
  wordCount: number;
  toleranceWpm?: number;
  maxTries?: number;
  startSpeed?: number;
}

export interface CalibrateTry {
  speed: number;
  wpm: number;
}

export interface Calibration {
  best: CalibrateTry & { synthesis: Synthesis };
  tries: CalibrateTry[];
}

/** Proportional step, kept inside the bracket found so far; pauses make wpm(speed) step-shaped. */
export function nextSpeed(speed: number, wpm: number, target: number, lo?: number, hi?: number): number {
  const guess = (speed * target) / wpm;
  if (lo !== undefined && hi !== undefined && !(lo < guess && guess < hi)) return (lo + hi) / 2;
  return guess;
}

const round = (value: number, places: number): number => Math.round(value * 10 ** places) / 10 ** places;

/** Synthesizes until the speaking rate lands within tolerance of the target, else returns the closest try. */
export async function calibrateSpeed(
  provider: TtsProvider,
  input: TtsInput,
  voice: string,
  opts: CalibrateOptions,
): Promise<Calibration> {
  const { targetWpm, wordCount, toleranceWpm = 5, maxTries = 10, startSpeed = 1 } = opts;
  const attempts: { synthesis: Synthesis; speed: number; wpm: number }[] = [];
  let speed = startSpeed;
  let lo: number | undefined;
  let hi: number | undefined;
  for (let n = 0; n < maxTries; n++) {
    const synthesis = await provider.synthesize(input, voice, { speed });
    const spoken = speakingSeconds(synthesis.audio);
    if (spoken <= 0) throw new TtsFailedError(provider.id, "calibration audio has no speech");
    const wpm = (wordCount / spoken) * 60;
    attempts.push({ synthesis, speed, wpm });
    if (Math.abs(wpm - targetWpm) <= toleranceWpm) break;
    if (wpm < targetWpm) lo = speed;
    else hi = speed;
    speed = nextSpeed(speed, wpm, targetWpm, lo, hi);
  }
  const closest = (a: (typeof attempts)[number], b: (typeof attempts)[number]) =>
    Math.abs(b.wpm - targetWpm) < Math.abs(a.wpm - targetWpm) ? b : a;
  const best = attempts.reduce(closest);
  const tries = attempts.map((a) => ({ speed: round(a.speed, 4), wpm: round(a.wpm, 1) }));
  return { best: { synthesis: best.synthesis, speed: round(best.speed, 4), wpm: round(best.wpm, 1) }, tries };
}
