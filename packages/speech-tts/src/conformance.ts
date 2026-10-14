import { describe, expect, it } from "vitest";
import { TtsTimeoutError, TtsUnavailableError, TtsUnsupportedError, type TtsError } from "./errors.js";
import type { TtsProvider } from "./types.js";

type Make = () => TtsProvider | Promise<TtsProvider>;

/** Three builds of one adapter kind. Every adapter passes this kit before it ships. */
export interface ConformanceHarness {
  /** A provider whose engine answers. Its declared capabilities pick which checks apply. */
  working: Make;
  /** The same kind, pointed at an engine that is not there. */
  unavailable: Make;
  /** The same kind, pointed at an engine that never answers. */
  hung: Make;
}

const SENTENCE = "the quick brown fox";
const HUNG_TIMEOUT_MS = 200;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.unreachable("expected a rejection"),
    (error: unknown) => error,
  );
}

function expectTyped(error: unknown, type: new (...args: never[]) => TtsError, provider: TtsProvider): void {
  expect(error).toBeInstanceOf(type);
  expect(error).toMatchObject({ providerId: provider.id });
}

function audioChecks(make: Make): void {
  it("returns audio at its declared sample rate, with a duration that matches the samples", async () => {
    const provider = await make();
    const voice = provider.capabilities.voices[0]?.id ?? "";

    const result = await provider.synthesize({ text: SENTENCE }, voice);

    expect(result.audio.sampleRate).toBe(provider.capabilities.sampleRate);
    expect(result.audio.samples.length).toBeGreaterThan(0);
    expect(result.durationS).toBeCloseTo(result.audio.samples.length / result.audio.sampleRate, 1);
  });

  it("returns ordered word timings inside the audio exactly when it declares them", async () => {
    const provider = await make();
    const voice = provider.capabilities.voices[0]?.id ?? "";

    const { words, durationS } = await provider.synthesize({ text: SENTENCE }, voice);

    if (!provider.capabilities.wordTimestamps) return expect(words).toBeUndefined();
    expect(words?.map((w) => w.word)).toEqual(SENTENCE.split(" "));
    words?.forEach((w, i) => {
      expect(w.end).toBeGreaterThan(w.start);
      expect(w.end).toBeLessThanOrEqual(durationS + 1e-6);
      if (i > 0) expect(w.start).toBeGreaterThanOrEqual(words[i - 1]?.end ?? 0);
    });
  });
}

function capabilityChecks(make: Make): void {
  it("rejects a voice it does not list with TtsUnsupportedError naming the voice", async () => {
    const provider = await make();

    const error = await rejection(provider.synthesize({ text: SENTENCE }, "no-such-voice"));

    expectTyped(error, TtsUnsupportedError, provider);
    expect(error).toMatchObject({ missing: ['voice "no-such-voice"'] });
  });

  it("takes token input only in an alphabet it declares", async () => {
    const provider = await make();
    const voice = provider.capabilities.voices[0]?.id ?? "";
    const tokens = [{ text: "fox", phonemes: "fˈɑks" }];

    for (const alphabet of ["ipa", "misaki"] as const) {
      const call = provider.synthesize({ tokens, alphabet }, voice);
      if (provider.capabilities.phonemeInput.includes(alphabet)) await expect(call).resolves.toBeDefined();
      else expectTyped(await rejection(call), TtsUnsupportedError, provider);
    }
  });

  it("changes the pace for a speed only when it declares speed control", async () => {
    const provider = await make();
    const voice = provider.capabilities.voices[0]?.id ?? "";
    const call = provider.synthesize({ text: SENTENCE }, voice, { speed: 2 });

    if (!provider.capabilities.speedControl) return expectTyped(await rejection(call), TtsUnsupportedError, provider);
    const normal = await provider.synthesize({ text: SENTENCE }, voice, { speed: 1 });
    expect((await call).durationS).toBeLessThan(normal.durationS);
  });
}

function failureChecks(harness: ConformanceHarness): void {
  it("reports a missing engine as TtsUnavailableError", async () => {
    const provider = await harness.unavailable();
    const voice = provider.capabilities.voices[0]?.id ?? "";

    expectTyped(await rejection(provider.synthesize({ text: SENTENCE }, voice)), TtsUnavailableError, provider);
  });

  it("gives up on a hung engine with TtsTimeoutError at the deadline", async () => {
    const provider = await harness.hung();
    const voice = provider.capabilities.voices[0]?.id ?? "";
    const started = Date.now();

    const error = await rejection(provider.synthesize({ text: SENTENCE }, voice, { timeoutMs: HUNG_TIMEOUT_MS }));

    expectTyped(error, TtsTimeoutError, provider);
    expect(Date.now() - started).toBeLessThan(HUNG_TIMEOUT_MS + 2_000);
  });
}

/** Registers the kit under `name`. Run it once per capability shape the adapter can be configured with. */
export function runTtsConformance(name: string, harness: ConformanceHarness): void {
  describe(`${name} conformance`, () => {
    audioChecks(harness.working);
    capabilityChecks(harness.working);
    failureChecks(harness);
  });
}
