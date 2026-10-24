import type { Audio } from "@titan-design/speech-tts";
import { LIBRARY_SAMPLE_RATE } from "./ffmpeg.js";
import type { GeneratorInfo, LedgerEntry } from "./ledger-schema.js";

export const PROCEDURAL_GENERATOR = "explainer-procedural";
export const PROCEDURAL_VERSION = "p1";

export const SFX_NAMES = ["click", "pop", "whoosh", "chime", "riser"] as const;
export type SfxName = (typeof SFX_NAMES)[number];

/** A generated clip with what the ledger needs to place it and to make it again. */
export interface Generated {
  audio: Audio;
  tags: string[];
  generator: GeneratorInfo;
  anchorS?: number;
  loop?: LedgerEntry["loop"];
}

const RATE = LIBRARY_SAMPLE_RATE;
const TAU = 2 * Math.PI;
const PEAK = 0.9;

/** mulberry32: a small seeded PRNG, so one seed always gives one file. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Scales to a fixed peak; scaling never moves where the peak is. */
function normalise(samples: Float32Array): Float32Array {
  let max = 0;
  for (const s of samples) max = Math.max(max, Math.abs(s));
  if (max > 0) for (let i = 0; i < samples.length; i++) samples[i] = (samples[i]! * PEAK) / max;
  return samples;
}

function render(durationS: number, sample: (t: number) => number): Float32Array {
  const samples = new Float32Array(Math.round(durationS * RATE));
  for (let i = 0; i < samples.length; i++) samples[i] = sample(i / RATE);
  return normalise(samples);
}

const info = (seed: number, params: GeneratorInfo["params"]): GeneratorInfo => ({ name: PROCEDURAL_GENERATOR, version: PROCEDURAL_VERSION, seed, params });

/** Semitone offsets from the root: I–vi–IV–V and I–IV–vi–V voicings, picked by seed. */
const PROGRESSIONS = [
  [[0, 4, 7], [-3, 0, 4], [-7, -3, 0], [-5, -1, 2]],
  [[0, 4, 7], [-7, -3, 0], [-3, 0, 4], [-5, -1, 2]],
] as const;
const ROOTS_HZ = [110, 130.81, 146.83, 164.81, 196] as const;

/**
 * Chord `index` holds its segment and crossfades into the next over the segment's last quarter (at most 1 s); time
 * wraps, so the last chord fades into the first across the loop point.
 */
function chordWeight(segment: number, durationS: number): (index: number, t: number) => number {
  const fade = Math.min(1, segment / 4);
  return (index, t) => {
    const into = (t - index * segment + durationS) % durationS;
    if (into < segment - fade) return 1;
    if (into < segment) return 0.5 + 0.5 * Math.cos((Math.PI * (into - segment + fade)) / fade);
    if (into > durationS - fade) return 0.5 - 0.5 * Math.cos((Math.PI * (into - durationS + fade)) / fade);
    return 0;
  };
}

export interface BedOptions {
  seed: number;
  durationS?: number;
  rootHz?: number;
}

/**
 * A pad bed: a four-chord progression of additive sines under a slow swell. Every frequency is a whole number of
 * cycles over the clip and each chord crossfades into the next, the last into the first, so the bed loops cleanly.
 */
export function generateBed({ seed, durationS = 16, rootHz }: BedOptions): Generated {
  const rand = random(seed);
  const progression = PROGRESSIONS[Math.floor(rand() * PROGRESSIONS.length)]!;
  const root = rootHz ?? ROOTS_HZ[Math.floor(rand() * ROOTS_HZ.length)]!;
  const cycles = (hz: number) => Math.round(hz * durationS) / durationS;
  const chords = progression.map((chord) => chord.flatMap((step) => {
    const hz = root * 2 ** (step / 12);
    return [{ hz: cycles(hz), gain: 1 }, { hz: cycles(hz * 2), gain: 0.3 }];
  }));
  const segment = durationS / chords.length;
  const lfo = cycles(1 / segment);
  const weight = chordWeight(segment, durationS);
  const samples = render(durationS, (t) => {
    const swell = 0.8 + 0.2 * Math.sin(TAU * lfo * t);
    return swell * chords.reduce((sum, chord, index) => {
      const w = weight(index, t);
      return w === 0 ? sum : sum + w * chord.reduce((acc, partial) => acc + partial.gain * Math.sin(TAU * partial.hz * t), 0);
    }, 0);
  });
  return {
    audio: { samples, sampleRate: RATE }, tags: ["calm", "pad"], loop: { startS: 0, endS: durationS },
    generator: info(seed, { kind: "bgm", durationS, rootHz: root }),
  };
}

/** An attack ramp to 1 at `peakS`, then exponential decay with time constant `decayS`. */
const strike = (t: number, peakS: number, decayS: number): number => (t < peakS ? t / peakS : Math.exp(-(t - peakS) / decayS));

/** One-pole low-passed white noise, its cutoff following `cutoffHz(t)`. */
function filteredNoise(seed: number, cutoffHz: (t: number) => number): (t: number) => number {
  const rand = random(seed);
  let state = 0;
  return (t) => {
    const alpha = 1 - Math.exp((-TAU * cutoffHz(t)) / RATE);
    state += alpha * (rand() * 2 - 1 - state);
    return state;
  };
}

interface SfxDesign {
  durationS: number;
  anchorS: number;
  sample: (seed: number) => (t: number) => number;
}

/** The phase of a sine whose frequency glides linearly from `from` to `to` over `spanS`. */
const glide = (from: number, to: number, spanS: number) => (t: number): number => TAU * (from * t + ((to - from) * t * t) / (2 * spanS));
const steady = (hz: number) => (t: number): number => TAU * hz * t;

/** A tone at its crest exactly at the anchor, so the clip's peak lands on `anchorS` and not a cycle either side. */
const crest = (phase: (t: number) => number, anchorS: number) => (t: number): number => Math.cos(phase(t) - phase(anchorS));

const CHIME_PARTIALS = [1, 2.76, 5.4].map((ratio, k) => ({ tone: crest(steady(880 * ratio), 0.003), gain: 1 / (k + 1) }));

const SFX: Record<SfxName, SfxDesign> = {
  click: { durationS: 0.03, anchorS: 0.001, sample: () => { const tone = crest(steady(2000), 0.001); return (t) => strike(t, 0.001, 0.004) * tone(t); } },
  pop: { durationS: 0.12, anchorS: 0.002, sample: () => { const tone = crest(glide(600, 200, 0.12), 0.002); return (t) => strike(t, 0.002, 0.025) * tone(t); } },
  chime: { durationS: 1.5, anchorS: 0.003, sample: () => (t) => strike(t, 0.003, 0.4) * CHIME_PARTIALS.reduce((sum, p) => sum + p.gain * p.tone(t), 0) },
  whoosh: {
    durationS: 0.6, anchorS: 0.4,
    sample: (seed) => {
      const noise = filteredNoise(seed, (t) => 300 + 5000 * Math.min(1, t / 0.4));
      return (t) => (t < 0.4 ? (t / 0.4) ** 8 : Math.exp(-(t - 0.4) / 0.01)) * noise(t);
    },
  },
  riser: {
    durationS: 1.5, anchorS: 1.2,
    sample: () => { const tone = crest(glide(200, 1200, 1.2), 1.2); return (t) => (t < 1.2 ? (t / 1.2) ** 2 : Math.exp(-(t - 1.2) / 0.03)) * tone(t); },
  },
};

/** One named SFX; `anchorS` is where its hit lands, so placement puts it at `cue − anchorS`. */
export function generateSfx(name: SfxName, seed: number): Generated {
  const design = SFX[name];
  return {
    audio: { samples: render(design.durationS, design.sample(seed)), sampleRate: RATE },
    tags: [name], anchorS: design.anchorS, generator: info(seed, { kind: "sfx", name }),
  };
}
