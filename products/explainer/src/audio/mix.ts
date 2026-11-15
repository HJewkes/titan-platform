import { resample, type Audio } from "@titan-design/speech-stt";

export const MIX_RATE = 48000;

export interface Clip {
  startS: number;
  audio: Audio;
}

const atMixRate = (audio: Audio): Float32Array => (audio.sampleRate === MIX_RATE ? audio.samples : resample(audio, MIX_RATE).samples);

/** One track of `lengthSamples` at 48 kHz with each clip resampled and laid at its start; samples past the end are dropped. */
export function layClips(clips: readonly Clip[], lengthSamples: number): Float32Array {
  const out = new Float32Array(lengthSamples);
  for (const clip of clips) {
    const samples = atMixRate(clip.audio);
    const offset = Math.round(clip.startS * MIX_RATE);
    for (let i = 0; i < samples.length && offset + i < lengthSamples; i++) out[offset + i]! += samples[i]!;
  }
  return out;
}

/**
 * Repeats `bed` to exactly `lengthSamples`, each repeat overlapping the last by a linear `crossfadeS`
 * crossfade. A bed longer than the target is cut.
 */
export function loopBed(bed: Audio, lengthSamples: number, crossfadeS = 2): Float32Array {
  const src = atMixRate(bed);
  const fade = Math.round(crossfadeS * MIX_RATE);
  if (src.length <= 2 * fade) throw new RangeError(`bed of ${src.length} samples is too short for a ${crossfadeS} s crossfade`);
  const period = src.length - fade;
  const out = new Float32Array(lengthSamples);
  for (let start = 0, copy = 0; start < lengthSamples; start += period, copy++) {
    const fadesOut = start + period < lengthSamples;
    for (let j = 0; j < src.length && start + j < lengthSamples; j++) {
      const inGain = copy > 0 && j < fade ? j / fade : 1;
      const outGain = fadesOut && j >= period ? (src.length - j) / fade : 1;
      out[start + j]! += src[j]! * inGain * outGain;
    }
  }
  return out;
}

/** A copy with a linear fade in over the first `inS` and a linear fade out over the last `outS`. */
export function fadeEnds(samples: Float32Array, inS = 1.5, outS = 3): Float32Array {
  const fadeIn = Math.round(inS * MIX_RATE);
  const fadeOut = Math.round(outS * MIX_RATE);
  return samples.map((v, i) => v * Math.min(1, i / fadeIn, (samples.length - i) / fadeOut));
}

/** The sample-wise sum of `tracks`, padded or cut to `lengthSamples`. */
export function sumTracks(tracks: readonly Float32Array[], lengthSamples: number): Float32Array {
  const out = new Float32Array(lengthSamples);
  for (const track of tracks) {
    for (let i = 0; i < track.length && i < lengthSamples; i++) out[i]! += track[i]!;
  }
  return out;
}
