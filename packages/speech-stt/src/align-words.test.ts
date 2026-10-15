import { describe, expect, it } from "vitest";
import {
  alignWords,
  CTC_START_OFFSET_S,
  tokenizeIpa,
  type AlignVoice,
  type AlignWordsOptions,
  type VoiceFamily,
} from "./align-words.js";
import type { CtcLogits } from "./ctc.js";
import { ctcForcedAlign } from "./ctc-align.js";

const VOCAB = ["<pad>", "ɔ", "l", "m", "æ", "z", "ə", "b", "ɛ", "ð", "h", "oʊ", "o", "ɑːɹ", "tʃ", "<unk>", "ɑ"];
const id = (token: string): number => VOCAB.indexOf(token);
const RAW: AlignVoice = { startOffsetS: 0 };
const options = (voice: AlignVoice): AlignWordsOptions => ({
  vocab: VOCAB,
  voice,
});

/** One frame per entry: 0 on that token, -10 elsewhere. `_` is the blank. */
function logitsFor(path: readonly string[]): CtcLogits {
  const data = new Float32Array(path.length * VOCAB.length).fill(-10);
  path.forEach((token, t) => {
    data[t * VOCAB.length + (token === "_" ? 0 : id(token))] = 0;
  });
  return { data, frames: path.length, vocabSize: VOCAB.length, frameS: 0.02 };
}

const LEAD = ["_", "_", "_", "_", "_", "_"];
const ALL_LLAMAS = ["_", "ɔ", "ɔ", "l", "_", "l", "æ", "æ", "m", "ə", "z", "_"];

describe("tokenizeIpa", () => {
  it("strips stress and prefers the longest vocab match", () => {
    expect(tokenizeIpa("ˈhɛloʊ", VOCAB)).toEqual([id("h"), id("ɛ"), id("l"), id("oʊ")]);
  });

  it("keeps a length mark inside one token", () => {
    expect(tokenizeIpa("ɑːɹ", VOCAB)).toEqual([id("ɑːɹ")]);
  });

  it("drops the tie bar so an affricate matches its token", () => {
    expect(tokenizeIpa("t͡ʃ", VOCAB)).toEqual([id("tʃ")]);
  });

  it("skips characters the vocab lacks", () => {
    expect(tokenizeIpa("l?q ə", VOCAB)).toEqual([id("l"), id("ə")]);
  });

  it("never matches a special token by its text", () => {
    expect(tokenizeIpa("<unk>", VOCAB)).toEqual([]);
  });
});

describe("alignWords", () => {
  it("spans each word from its first phone's start to its last phone's end", () => {
    const logits = logitsFor(ALL_LLAMAS);
    const spans = ctcForcedAlign(logits, [id("ɔ"), id("l"), id("l"), id("æ"), id("m"), id("ə"), id("z")]);

    const words = alignWords(["all", "llamas"], ["ɔl", "læməz"], logits, options(RAW));

    expect(words[0]!.start).toBeCloseTo(spans[0]!.start, 9);
    expect(words[0]!.end - words[0]!.start).toBeCloseTo(
      spans[0]!.end - spans[0]!.start + (spans[1]!.end - spans[1]!.start),
      9,
    );
    expect(words[1]!.start).toBeCloseTo(spans[2]!.start, 9);
    expect(words[1]!.end).toBeCloseTo(spans[6]!.end, 9);
    expect(words.map((w) => w.text)).toEqual(["all", "llamas"]);
  });

  it("moves each start earlier by the voice family's offset and leaves ends alone", () => {
    const pause = ["_", "_", "_", "_", "_", "_", "_"];
    const logits = logitsFor([...LEAD, "_", "ɔ", "ɔ", "l", ...pause, "l", "æ", "æ", "m", "ə", "z", "_"]);
    const raw = alignWords(["all", "llamas"], ["ɔl", "læməz"], logits, options(RAW));
    const families: [VoiceFamily, number[]][] = [
      ["kokoro", [0.084, 0.284]],
      ["xtts", [0.111, 0.311]],
    ];

    for (const [family, starts] of families) {
      const words = alignWords(["all", "llamas"], ["ɔl", "læməz"], logits, options(family));
      expect(words.map((w) => w.start)).toEqual(starts);
      expect(words.map((w) => w.end)).toEqual(raw.map((w) => w.end));
      expect(CTC_START_OFFSET_S[family]).toBeLessThan(0);
      expect(raw.map((w, k) => Math.round((w.start - words[k]!.start) * 1000))).toEqual(
        Array<number>(2).fill(Math.round(-CTC_START_OFFSET_S[family] * 1000)),
      );
    }
  });

  it("clamps a shifted start at zero and clips the previous end it would overlap", () => {
    const words = alignWords(["all", "llamas"], ["ɔl", "læməz"], logitsFor(ALL_LLAMAS), options("kokoro"));

    expect(words[0]!.start).toBe(0);
    expect(words[1]!.start).toBe(0.044);
    expect(words[0]!.end).toBe(0.044);
    for (const w of words) expect(w.end).toBeGreaterThanOrEqual(w.start);
  });

  it("keeps a word with no phones, zero-length at the previous word's end", () => {
    const logits = logitsFor(["_", "ð", "ð", "ə", "_", "b", "ɛ", "ɛ", "l", "_"]);

    const words = alignWords(["the", "—", "bell"], ["ðə", "", "bɛl"], logits, options(RAW));

    expect(words.map((w) => w.text)).toEqual(["the", "—", "bell"]);
    expect(words[1]).toEqual({
      text: "—",
      start: words[0]!.end,
      end: words[0]!.end,
    });
  });

  it("throws when script and phones differ in length", () => {
    expect(() => alignWords(["a", "b"], ["ɔ"], logitsFor(["_", "ɔ"]), options(RAW))).toThrow(RangeError);
  });

  it("throws when no word has an alignable phone", () => {
    expect(() => alignWords(["—"], [""], logitsFor(["_", "_"]), options(RAW))).toThrow(RangeError);
  });

  it("requires a voice at compile time", () => {
    // @ts-expect-error voice is required
    const missing: AlignWordsOptions = { vocab: VOCAB };
    expect(missing.vocab).toBe(VOCAB);
  });
});
