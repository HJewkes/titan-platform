import type { Audio } from "./schemas.js";

/** Zero crossings of the sinc on each side of the centre tap. More is sharper and slower. */
const ZERO_CROSSINGS = 16;
/** The pass band ends a little below the lower Nyquist so the transition band does not alias. */
const ROLLOFF = 0.95;

/**
 * Converts mono audio to `toRate` with a Blackman-windowed sinc, in TypeScript, so callers
 * need no ffmpeg. Kokoro's 24 kHz becomes a recogniser's 16 kHz. The output has
 * `round(n * toRate / fromRate)` samples.
 */
export function resample(audio: Audio, toRate: number): Audio {
  const fromRate = audio.sampleRate;
  assertRate(fromRate, "audio.sampleRate");
  assertRate(toRate, "toRate");
  if (fromRate === toRate) return { samples: audio.samples.slice(), sampleRate: toRate };
  const g = gcd(fromRate, toRate);
  const up = toRate / g;
  const down = fromRate / g;
  const cutoff = 0.5 * Math.min(1, toRate / fromRate) * ROLLOFF;
  const halfWidth = Math.ceil(ZERO_CROSSINGS / (2 * cutoff));
  const phases = Array.from({ length: up }, (_, p) => phaseTaps(p / up, cutoff, halfWidth));
  const input = audio.samples;
  const out = new Float32Array(Math.round((input.length * up) / down));
  for (let k = 0; k < out.length; k++) {
    const base = Math.floor((k * down) / up);
    const taps = phases[(k * down) % up]!;
    let sum = 0;
    for (let t = 0; t < taps.length; t++) {
      const i = base - halfWidth + 1 + t;
      if (i >= 0 && i < input.length) sum += input[i]! * taps[t]!;
    }
    out[k] = sum;
  }
  return { samples: out, sampleRate: toRate };
}

/** Weights for input samples `base - halfWidth + 1 .. base + halfWidth`, the output sitting `frac` past `base`. */
function phaseTaps(frac: number, cutoff: number, halfWidth: number): Float64Array {
  const taps = new Float64Array(2 * halfWidth);
  let total = 0;
  for (let t = 0; t < taps.length; t++) {
    const x = t - halfWidth + 1 - frac;
    const w = 2 * cutoff * sinc(2 * cutoff * x) * blackman(x / halfWidth);
    taps[t] = w;
    total += w;
  }
  return taps.map((w) => w / total);
}

function sinc(x: number): number {
  return x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
}

/** Blackman window over `u` in [-1, 1], zero outside. */
function blackman(u: number): number {
  if (Math.abs(u) >= 1) return 0;
  return 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function assertRate(rate: number, name: string): void {
  if (!Number.isInteger(rate) || rate <= 0) throw new RangeError(`${name} must be a positive integer, got ${rate}`);
}
