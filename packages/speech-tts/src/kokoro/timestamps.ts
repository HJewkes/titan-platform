import { TtsFailedError } from "../errors.js";

const SAMPLE_RATE = 24_000;
const HOP = 600;
// Python's join_timestamps counts half-frames so a space splits evenly; its literal 80 is this.
const HALF_FRAMES_PER_SECOND = (2 * SAMPLE_RATE) / HOP;
const BOS_OFFSET_FRAMES = 3;

/** The parts of a misaki token that Kokoro's timing reads. */
export interface TimedToken {
  readonly phonemes: string | null;
  readonly whitespace: string;
}

/** Seconds from the chunk start; null where Python leaves `start_ts`/`end_ts` unset. */
interface TokenTime {
  readonly start: number | null;
  readonly end: number | null;
}

// torch.round rounds half to even; Math.round rounds half up.
function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  if (x - floor !== 0.5) return Math.round(x);
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Kokoro's raw float durations to whole frames: `round().clamp(min=1)`, as KModel does. */
export function roundDurations(raw: ArrayLike<number>): number[] {
  return Array.from(raw, (x) => Math.max(1, roundHalfEven(x)));
}

/** The waveform is rendered from the rounded frames, so any other length means a swapped model or export. */
export function assertFramesMatchWaveform(providerId: string, frames: readonly number[], samples: number): void {
  const frameSum = frames.reduce((a, b) => a + b, 0);
  if (frameSum * HOP === samples) return;
  throw new TtsFailedError(
    providerId,
    `kokoro durations sum to ${frameSum} frames (${frameSum * HOP} samples at hop ${HOP}) but the waveform has ${samples} samples`,
  );
}

/**
 * Port of kokoro 0.9.4 `KPipeline.join_timestamps`. `frames` are the rounded durations including
 * `<bos>` and `<eos>`. Python mutates its tokens; this returns one time per token instead.
 */
export function joinTimestamps(tokens: readonly TimedToken[], frames: readonly number[]): TokenTime[] {
  const times: TokenTime[] = tokens.map(() => ({ start: null, end: null }));
  if (tokens.length === 0 || frames.length < 3) return times;
  const frame = (k: number): number => frames[k] ?? 0;
  const sum = (from: number, to: number): number => frames.slice(from, to).reduce((a, b) => a + b, 0);
  let left = 2 * Math.max(0, frame(0) - BOS_OFFSET_FRAMES);
  let right = left;
  let i = 1;
  for (const [k, token] of tokens.entries()) {
    if (i >= frames.length - 1) break;
    if (!token.phonemes) {
      if (token.whitespace) {
        i += 1;
        left = right + frame(i);
        right = left + frame(i);
        i += 1;
      }
      continue;
    }
    const j = i + [...token.phonemes].length;
    if (j >= frames.length) break;
    const start = left / HALF_FRAMES_PER_SECOND;
    const spaceFrames = token.whitespace ? frame(j) : 0;
    left = right + 2 * sum(i, j) + spaceFrames;
    times[k] = { start, end: left / HALF_FRAMES_PER_SECOND };
    right = left + spaceFrames;
    i = j + (token.whitespace ? 1 : 0);
  }
  return times;
}
