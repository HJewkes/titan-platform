import { describe, expect, it } from "vitest";
import { resample } from "./resample.js";

function sine(freq: number, rate: number, n: number): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * freq * i) / rate));
}

/** Index of the largest DFT magnitude among bins 1..n/2. */
function peakBin(x: Float32Array): number {
  let best = 0;
  let bestPower = -1;
  for (let k = 1; k <= x.length / 2; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < x.length; i++) {
      const phase = (2 * Math.PI * k * i) / x.length;
      re += x[i]! * Math.cos(phase);
      im -= x[i]! * Math.sin(phase);
    }
    if (re * re + im * im > bestPower) [best, bestPower] = [k, re * re + im * im];
  }
  return best;
}

describe("resample", () => {
  const n = 4801;
  const tone = { samples: sine(1000, 24000, n), sampleRate: 24000 };

  // Mutation caught: the ratio inverted, so the output is 1.5x the input, not 2/3.
  it("resamples 24 kHz to 16 kHz with round(n * 16 / 24) samples", () => {
    const out = resample(tone, 16000);

    expect(out.sampleRate).toBe(16000);
    expect(out.samples.length).toBe(Math.round((n * 16) / 24));
  });

  // Mutation caught: the input step per output sample inverted (2/3 for 3/2), which moves the tone to 444 Hz.
  it("keeps a 1 kHz sine's peak bin within one bin", () => {
    const out = resample(tone, 16000).samples;

    const expectedBin = (1000 * out.length) / 16000;

    expect(Math.abs(peakBin(out) - expectedBin)).toBeLessThanOrEqual(1);
  });

  // Mutation caught: the anti-alias cutoff left at the input Nyquist, so 10 kHz folds to 6 kHz.
  it("suppresses a tone above the output Nyquist", () => {
    const loud = resample({ samples: sine(1000, 24000, n), sampleRate: 24000 }, 16000).samples;
    const folded = resample({ samples: sine(10000, 24000, n), sampleRate: 24000 }, 16000).samples;

    const rms = (x: Float32Array): number => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

    expect(rms(folded)).toBeLessThan(rms(loud) * 0.05);
  });

  // Mutation caught: a zero or fractional rate accepted, which loops on gcd or yields NaN lengths.
  it("rejects a rate that is not a positive integer", () => {
    expect(() => resample(tone, 0)).toThrow(RangeError);
    expect(() => resample({ samples: tone.samples, sampleRate: 22050.5 }, 16000)).toThrow(RangeError);
  });
});
