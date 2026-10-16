import { describe, expect, it, vi } from "vitest";
import { resolveTtsConfig } from "../config.js";
import { TtsConfigError, TtsFailedError } from "../errors.js";
import { createTtsRegistry } from "../registry.js";
import type { TtsToken } from "../types.js";
import { fakeEngine, letterG2p, type FakeEngineOptions } from "./fake-engine.test-helpers.js";
import { kokoroFactory, kokoroProvider } from "./provider.js";

const misaki = (tokens: TtsToken[]) => ({ tokens, alphabet: "misaki" as const });

function setup(engineOptions: FakeEngineOptions = {}) {
  const engine = fakeEngine(engineOptions);
  const g2p = letterG2p();
  const onWarning = vi.fn<(message: string) => void>();
  const provider = kokoroProvider({ g2p, onWarning, loadEngine: () => Promise.resolve(engine) });
  return { engine, g2p, onWarning, provider };
}

function profile(entry: Record<string, unknown>) {
  return resolveTtsConfig({ env: {}, profile: { version: 1, tts: { providers: { local: { kind: "kokoro", ...entry } } } } });
}

describe("kokoroFactory in a registry", () => {
  const registry = () => createTtsRegistry().register("kokoro", kokoroFactory({ g2p: letterG2p(), loadEngine: () => Promise.resolve(fakeEngine()) }));

  it("is selected for misaki token input with word timestamps and speed control", () => {
    const { provider } = registry().select(profile({ voices: ["af_heart"] }), { phonemeInput: "misaki", wordTimestamps: true, speedControl: true });

    expect(provider.id).toBe("local");
    expect(provider.capabilities.voices.map((v) => v.id)).toEqual(["af_heart"]);
  });

  // Mutation caught: dtype is passed through, so a q8f16 profile loads a model whose durations drift.
  it("fails closed on a profile asking for a precision other than fp32", () => {
    const select = () => registry().select(profile({ dtype: "q8f16" }), { phonemeInput: "misaki" });

    expect(select).toThrow(TtsConfigError);
    expect(select).toThrow(/dtype must be "fp32"/);
  });
});

describe("kokoroFactory with a speech runtime", () => {
  const CACHE = "/tmp/Test Cache/titan speech";
  const runtime = (tts: "cpu" | "cuda", source: "env" | "default") => ({
    device: { tts, stt: "cpu", phones: "cpu" } as const,
    cacheDir: CACHE,
    source: { device: { tts: source, stt: source, phones: source }, cacheDir: source },
  });
  const loadedWith = async (entry: Record<string, unknown>, rt?: ReturnType<typeof runtime>) => {
    const seen: unknown[] = [];
    const loadEngine = (options: unknown) => {
      seen.push(options);
      return Promise.resolve(fakeEngine());
    };
    await kokoroFactory({ g2p: letterG2p(), loadEngine, ...(rt ? { runtime: rt } : {}) })("local", { kind: "kokoro", ...entry }).synthesize(misaki([{ text: "a", phonemes: "a" }]), "af_heart");
    return seen;
  };

  // Mutation caught: kokoroFactory ignores runtime.source, so the profile entry always wins over an env choice.
  it("lets an env-sourced runtime device beat the entry's own", async () => {
    expect(await loadedWith({ device: "cpu" }, runtime("cuda", "env"))).toEqual([{ device: "cuda", cacheDir: CACHE }]);
  });

  it("keeps the entry's device and cache over a default-sourced runtime", async () => {
    expect(await loadedWith({ device: "cpu", cacheDir: "/entry/cache" }, runtime("cuda", "default"))).toEqual([{ device: "cpu", cacheDir: "/entry/cache" }]);
  });

  it("takes the runtime's values for what the entry omits", async () => {
    expect(await loadedWith({}, runtime("cpu", "default"))).toEqual([{ device: "cpu", cacheDir: CACHE }]);
  });

  it("loads on cpu with no cache when there is neither a runtime nor an entry value", async () => {
    expect(await loadedWith({})).toEqual([{ device: "cpu" }]);
  });
});

describe("kokoroProvider", () => {
  // Mutation caught (TP-2955): the provider re-runs G2P on the token text instead of speaking the override.
  it("speaks override phonemes verbatim and reports the ps it sent", async () => {
    const { engine, g2p, provider } = setup();

    const result = await provider.synthesize(misaki([{ text: "read", phonemes: "ɹˈɛd", whitespace: " " }, { text: "it", phonemes: "ɪt" }]), "af_heart");

    expect(engine.tokenized).toEqual(["ɹˈɛd ɪt"]);
    expect(result.phonemes).toEqual(["ɹˈɛd ɪt"]);
    expect(g2p.calls).toEqual([]);
  });

  it("reads a token that brings no phonemes through the G2P, on its own", async () => {
    const { engine, g2p, provider } = setup();

    await provider.synthesize(misaki([{ text: "Wave", whitespace: " " }, { text: "it", phonemes: "ɪt" }]), "af_heart");

    expect(g2p.calls).toEqual(["Wave"]);
    expect(engine.tokenized).toEqual(["wave ɪt"]);
  });

  // Mutation caught: style row len(ps), the kokoro-js 1.2.1 bug.
  it("styles a chunk with voice-pack row len(ps) - 1", async () => {
    const { engine, provider } = setup();

    await provider.synthesize(misaki([{ text: "abc", phonemes: "abc" }]), "af_heart");

    expect(engine.runs.map((r) => r.styleRow)).toEqual([2]);
  });

  // Mutation caught: an unspoken word is dropped from the timings, or takes time from the next word.
  it("gives a word with no phonemes a zero-width timing where the last word ended, and warns", async () => {
    const { onWarning, provider } = setup();
    const tokens = [
      { text: "one", phonemes: "wˈʌn", whitespace: " " },
      { text: "Zyx", phonemes: "", whitespace: " " },
      { text: "two", phonemes: "tˈu" },
      { text: ".", phonemes: "." },
    ];

    const { words } = await provider.synthesize(misaki(tokens), "af_heart");

    // Every id lasts 2 frames: 2 half-frames each, /80. Python skips two ids for "Zyx"'s space, so "two" starts at 22.
    expect(words).toEqual([
      { word: "one", start: 0, end: 18 / 80 },
      { word: "Zyx", start: 18 / 80, end: 18 / 80 },
      { word: "two", start: 22 / 80, end: 36 / 80 },
    ]);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("Zyx"));
  });

  it("times a word with partial phonemes by its own phoneme count", async () => {
    const { onWarning, provider } = setup();

    const { words } = await provider.synthesize(misaki([{ text: "Qrst", phonemes: "kɹ", whitespace: " " }, { text: "two", phonemes: "tˈu" }]), "af_heart");

    expect(words).toEqual([
      { word: "Qrst", start: 0, end: 10 / 80 },
      { word: "two", start: 10 / 80, end: 24 / 80 },
    ]);
    expect(onWarning).not.toHaveBeenCalled();
  });

  // Mutation caught: the frame-sum check removed, so a swapped export's misaligned timings pass silently.
  it("rejects a waveform one hop short of the durations, naming both counts", async () => {
    const { provider } = setup({ shortBy: 600 });

    const call = provider.synthesize(misaki([{ text: "it", phonemes: "ɪt" }]), "af_heart");

    await expect(call).rejects.toBeInstanceOf(TtsFailedError);
    await expect(call).rejects.toThrow(/sum to 8 frames \(4800 samples at hop 600\) but the waveform has 4200 samples/);
  });

  // Mutation caught: the id count is not checked, so a dropped phoneme shifts every later word.
  it("rejects phonemes the tokenizer drops, naming them", async () => {
    const { provider } = setup({ drop: "ʔ" });

    const call = provider.synthesize(misaki([{ text: "uh-oh", phonemes: "ʌʔoʊ" }]), "af_heart");

    await expect(call).rejects.toBeInstanceOf(TtsFailedError);
    await expect(call).rejects.toThrow(/gave 5 ids for 4 phonemes; it drops "ʔ"/);
  });
});
