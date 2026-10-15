import { setTimeout as sleep } from "node:timers/promises";
import { assertSupported } from "./capabilities.js";
import { withDeadline } from "./deadline.js";
import { TtsUnavailableError } from "./errors.js";
import type { Synthesis, SynthesizeOptions, TtsCapabilities, TtsInput, TtsProvider, WordTiming } from "./types.js";

export interface FakeTtsOptions {
  id?: string;
  capabilities?: Partial<TtsCapabilities>;
  /** Simulated engine time per call, so tests can drive the deadline. */
  latencyMs?: number;
  timeoutMs?: number;
  /** Every call rejects with TtsUnavailableError, as a missing engine would. */
  unavailable?: boolean;
}

export interface FakeTtsCall {
  input: TtsInput;
  voice: string;
  options: SynthesizeOptions;
}

export interface FakeTtsProvider extends TtsProvider {
  readonly calls: readonly FakeTtsCall[];
}

export const FAKE_TTS_CAPABILITIES: TtsCapabilities = {
  phonemeInput: ["ipa", "misaki"],
  wordTimestamps: true,
  speedControl: true,
  voices: [
    { id: "fake-a", languages: ["en-US"] },
    { id: "fake-b", languages: ["en-GB"] },
  ],
  languages: ["en-US", "en-GB"],
  sampleRate: 24_000,
};

const WORD_S = 0.3;
const GAP_S = 0.1;

const wordsOf = (input: TtsInput): string[] =>
  "tokens" in input ? input.tokens.map((t) => t.text) : input.text.split(/\s+/).filter(Boolean);

/** A 220 Hz tone per word with a gap after each, so durations and timings are predictable. */
function render(words: readonly string[], speed: number, sampleRate: number): { samples: Float32Array; timings: WordTiming[] } {
  const wordS = WORD_S / speed;
  const slotS = wordS + GAP_S / speed;
  const samples = new Float32Array(Math.round(words.length * slotS * sampleRate));
  const timings = words.map((word, i) => ({ word, start: i * slotS, end: i * slotS + wordS }));
  for (const { start, end } of timings) {
    for (let n = Math.round(start * sampleRate); n < Math.round(end * sampleRate); n++) {
      samples[n] = 0.1 * Math.sin((2 * Math.PI * 220 * n) / sampleRate);
    }
  }
  return { samples, timings };
}

/** A deterministic in-memory provider for tests and dry runs; it honours its declared capabilities. */
export function fakeTts(opts: FakeTtsOptions = {}): FakeTtsProvider {
  const id = opts.id ?? "fake";
  const capabilities = { ...FAKE_TTS_CAPABILITIES, ...opts.capabilities };
  const calls: FakeTtsCall[] = [];
  const synthesize = async (input: TtsInput, voice: string, options: SynthesizeOptions = {}): Promise<Synthesis> => {
    calls.push({ input, voice, options });
    assertSupported(id, capabilities, input, voice, options);
    if (opts.unavailable) throw new TtsUnavailableError(id, "fake engine is switched off");
    return withDeadline(id, options.timeoutMs ?? opts.timeoutMs ?? 30_000, options.signal, async (signal) => {
      if (opts.latencyMs) await sleep(opts.latencyMs, undefined, { signal });
      const { samples, timings } = render(wordsOf(input), options.speed ?? 1, capabilities.sampleRate);
      const audio = { samples, sampleRate: capabilities.sampleRate };
      const phonemes = "tokens" in input ? input.tokens.map((t) => t.phonemes ?? "") : undefined;
      return {
        audio,
        durationS: samples.length / capabilities.sampleRate,
        ...(capabilities.wordTimestamps ? { words: timings } : {}),
        ...(phonemes ? { phonemes } : {}),
      };
    });
  };
  return { id, capabilities, calls, synthesize };
}
