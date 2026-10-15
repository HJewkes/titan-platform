import { readFileSync } from "node:fs";
import { misakiEnglish, ttsTokens } from "@titan-design/speech-g2p";
import { describe, expect, it } from "vitest";
import type { TtsToken, WordTiming } from "../types.js";
import type { KokoroEngine } from "./engine.js";
import { indexedPack } from "./fake-engine.test-helpers.js";
import { kokoroProvider } from "./provider.js";

interface GoldenToken {
  readonly text: string;
  readonly phonemes: string | null;
  readonly whitespace: string;
  readonly start_ts: number | null;
  readonly end_ts: number | null;
}

interface Golden {
  readonly voice: string;
  readonly speed: number;
  readonly pred_dur: number[];
  readonly tokens: GoldenToken[];
}

const HOP = 600;
const ONE_MS = 0.001;
const IS_WORD = /[\p{L}\p{N}]/u;

function loadGolden(): Golden {
  const parsed: unknown = JSON.parse(readFileSync(new URL("../fixtures/kokoro/r4-8.golden.json", import.meta.url), "utf8"));
  const isGolden = (v: unknown): v is Golden => typeof v === "object" && v !== null && ["voice", "speed", "pred_dur", "tokens"].every((k) => k in v);
  if (!isGolden(parsed)) throw new Error("unexpected fixture shape: r4-8.golden.json");
  return parsed;
}

/** Replays Python's frames: the integer durations round to themselves, and the waveform is `sum × 600` samples. */
function replayEngine(durations: readonly number[]): KokoroEngine {
  return {
    tokenize: (ps) => [0, ...[...ps].map((_, k) => k + 1), 0],
    voicePack: () => Promise.resolve(indexedPack()),
    run: () =>
      Promise.resolve({
        waveform: new Float32Array(durations.reduce((a, b) => a + b, 0) * HOP),
        durations: Float32Array.from(durations),
      }),
    dispose: () => Promise.resolve(),
  };
}

/** Stands in for the espeak peer, which speech-g2p has not wired: reads an out-of-lexicon word as Python's golden did. */
function goldenFallback(golden: Golden): (token: { text: string }) => string | null {
  const byText = new Map(golden.tokens.map((t) => [t.text, t.phonemes]));
  return (token) => byText.get(token.text) ?? null;
}

function provider(golden: Golden) {
  return kokoroProvider({
    g2p: misakiEnglish({ fallback: goldenFallback(golden) }),
    loadEngine: () => Promise.resolve(replayEngine(golden.pred_dur)),
    onWarning: () => undefined,
  });
}

function goldenWords(golden: Golden): WordTiming[] {
  return golden.tokens
    .filter((t) => IS_WORD.test(t.text))
    .map((t) => ({ word: t.text, start: t.start_ts ?? Number.NaN, end: t.end_ts ?? Number.NaN }));
}

const describeTokens = (tokens: readonly { text: string; phonemes: string | null; whitespace: string }[]): string[] =>
  tokens.map((t) => `${JSON.stringify(t.text)} /${t.phonemes ?? "∅"}/ ${JSON.stringify(t.whitespace)}`);

function expectWithinOneMs(actual: readonly WordTiming[], expected: readonly WordTiming[]): void {
  expect(actual.map((w) => w.word)).toEqual(expected.map((w) => w.word));
  actual.forEach((w, k) => {
    expect(Math.abs(w.start - (expected[k]?.start ?? Number.NaN)), `${w.word} start`).toBeLessThanOrEqual(ONE_MS);
    expect(Math.abs(w.end - (expected[k]?.end ?? Number.NaN)), `${w.word} end`).toBeLessThanOrEqual(ONE_MS);
  });
}

describe("kokoroProvider with the real misaki G2P on r4-8", () => {
  const golden = loadGolden();
  const spoken = golden.tokens.map((t) => t.text + t.whitespace).join("");

  it("reads the same phonemes as the Python golden", () => {
    const tokens = misakiEnglish().tokens(spoken);

    expect(describeTokens(tokens)).toEqual(describeTokens(golden.tokens));
  });

  // Mutation caught: dropping the ttsTokens path, or a golden duration shifted by one frame, moves a word.
  it("times every word within 1 ms of Python from text", async () => {
    const synthesis = await provider(golden).synthesize({ text: spoken }, golden.voice, { speed: golden.speed });

    expectWithinOneMs(synthesis.words ?? [], goldenWords(golden));
  });

  it("gives the same words from ttsTokens() as token input", async () => {
    const g2p = misakiEnglish({ fallback: goldenFallback(golden) });
    const tokens: TtsToken[] = ttsTokens(g2p.tokens(spoken));

    const synthesis = await provider(golden).synthesize({ tokens, alphabet: "misaki" }, golden.voice, { speed: golden.speed });

    expectWithinOneMs(synthesis.words ?? [], goldenWords(golden));
  });
});
