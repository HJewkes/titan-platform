import type { Audio } from "./types.js";

export interface SpeakingOptions {
  /** Silent runs at least this long between voiced frames are pauses and are not counted. */
  pauseS?: number;
  /** Frames quieter than this many dB below the loudest frame are silent. */
  silenceDb?: number;
}

const FRAME_S = 0.01;

function frameRms(samples: Float32Array, hop: number): number[] {
  const rms: number[] = [];
  for (let at = 0; at + hop <= samples.length; at += hop) {
    let sum = 0;
    for (let i = at; i < at + hop; i++) sum += samples[i]! * samples[i]!;
    rms.push(Math.sqrt(sum / hop) + 1e-12);
  }
  return rms;
}

/**
 * Seconds of speech in `audio`: leading and trailing silence trimmed, and silent runs
 * of `pauseS` or more removed, so a words-per-minute figure ignores deliberate pauses.
 */
export function speakingSeconds(audio: Audio, opts: SpeakingOptions = {}): number {
  const { pauseS = 0.25, silenceDb = -40 } = opts;
  const rms = frameRms(audio.samples, Math.floor(audio.sampleRate / 100));
  const peak = Math.max(...rms, 0);
  if (peak <= 1e-9) return 0;
  const voiced = rms.map((r) => 20 * Math.log10(r / peak) > silenceDb);
  const first = voiced.indexOf(true);
  if (first < 0) return 0;
  const last = voiced.lastIndexOf(true);
  let pauses = 0;
  let run = 0;
  for (let i = first; i <= last; i++) {
    if (voiced[i]) {
      if (run * FRAME_S >= pauseS) pauses += run;
      run = 0;
    } else run++;
  }
  return (last - first + 1 - pauses) * FRAME_S;
}
