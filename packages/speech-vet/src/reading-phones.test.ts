import { misakiToIpa } from "@titan-design/speech-g2p";
import { describe, expect, it } from "vitest";
import { englishHeteronyms, type PhonemeToken } from "./heteronyms.js";
import { checkHeardReadings, expandReading, readingIpa } from "./reading-phones.js";

// Synthetic lines. Tokens are in misaki notation as misakiEnglish().tokens() emits them. Apart from the
// recorded fixture below, the recognizer strings are constructed in wav2vec2's espeak-style output.
function tokens(...pairs: Array<[text: string, phonemes: string | null]>): PhonemeToken[] {
  return pairs.map(([text, phonemes]) => ({ text, phonemes, whitespace: " " }));
}

// Recorded: misakiEnglish().tokens("the show is live") → kokoroProvider (Kokoro-82M-v1.0-ONNX-timestamped, fp32, af_heart)
// → resample to 16 kHz → wav2vec2Recognizer (onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX@c69750f5, fp32, cpu).
const RECORDED_SHOW_IS_LIVE = {
  tokens: tokens(["the", "ðə"], ["show", "ʃˈO"], ["is", "ɪz"], ["live", "lˈIv"]),
  recognized: "ð ə ʃ oʊ ɪ z l aɪ v",
};

const SHOW_IS_LIVE_ADJ = tokens(["the", "ðə"], ["show", "ʃˈO"], ["is", "ɪz"], ["live", "lˈIv"], [".", "."]);
const PRONOUN_I_LIVE_VERB = tokens(["I", "ˈI"], ["live", "lˈɪv"], ["here", "hˈɪɹ"], [".", "."]);
const PRONOUN_I_SHOW_IS_LIVE = tokens(["I", "ˈI"], ["think", "θˈɪŋk"], ...SHOW_IS_LIVE_ADJ.map((t): [string, string | null] => [t.text, t.phonemes]));

function heard(spoken: string, line: PhonemeToken[], recognized: string): Array<[string, string, string]> {
  return checkHeardReadings(spoken, line, recognized, { toIpa: misakiToIpa }).map((r) => [r.declared, r.heard, r.status]);
}

describe("checkHeardReadings", () => {
  // Catches: the heard reading taken from the tokens instead of the audio, so the declared verb passes.
  it("the recorded show is live, heard as the adjective against a declared verb, fails", () => {
    const { tokens: line, recognized } = RECORDED_SHOW_IS_LIVE;
    expect(heard("the show is [live](=verb)", line, recognized)).toEqual([["verb", "adj", "fail"]]);
  });

  it("the recorded show is live against a declared adjective is ok", () => {
    const { tokens: line, recognized } = RECORDED_SHOW_IS_LIVE;
    const [reading] = checkHeardReadings("the show is [live](=adj)", line, recognized, { toIpa: misakiToIpa });
    expect(reading).toEqual({ word: "live", occurrence: 1, declared: "adj", heard: "adj", heardPhones: "laɪv", distance: 0, status: "ok" });
  });

  it("packed recognizer output aligns as the spaced output does", () => {
    expect(heard("The show is [live](=verb).", SHOW_IS_LIVE_ADJ, "ðəʃoʊɪzlaɪv")).toEqual([["verb", "adj", "fail"]]);
  });

  // Catches: the voice departing from tokens that already carry the declared reading going unseen.
  it("a voice that departs from correct tokens fails", () => {
    expect(heard("I [live](=verb) here.", PRONOUN_I_LIVE_VERB, "aɪlaɪvhɪɹ")).toEqual([["verb", "adj", "fail"]]);
  });

  // The pronoun-I fixture. Catches: misaki I mapped to ɪ, which makes the two readings of live one IPA string.
  it("pronoun I beside live keeps the two readings apart", () => {
    expect(heard("I [live](=verb) here.", PRONOUN_I_LIVE_VERB, "aɪlɪvhɪɹ")).toEqual([["verb", "verb", "ok"]]);
    expect(heard("I think the show is [live](=verb).", PRONOUN_I_SHOW_IS_LIVE, "aɪθɪŋkðəʃoʊɪzlaɪv")).toEqual([["verb", "adj", "fail"]]);
  });

  it("audio that stops before the word is inconclusive", () => {
    expect(heard("The show is [live](=adj).", SHOW_IS_LIVE_ADJ, "ðəʃoʊɪz")).toEqual([["adj", "unknown", "inconclusive"]]);
  });

  it("checks only declared occurrences, each at its own place in the line", () => {
    const line = tokens(["we", "wi"], ["live", "lˈɪv"], ["here", "hˈɪɹ"], ["and", "ænd"], ["the", "ðə"], ["show", "ʃˈO"], ["is", "ɪz"], ["live", "lˈIv"]);
    const results = checkHeardReadings("We live here and the show is [live](=adj)", line, "wilɪvhɪɹænðəʃoʊɪzlɪv", { toIpa: misakiToIpa });
    expect(results.map((r) => [r.occurrence, r.declared, r.heard, r.status])).toEqual([[2, "adj", "verb", "fail"]]);
  });
});

describe("readingIpa", () => {
  // Catches: any reading pair that collapses to one IPA string after stress stripping, the I/ɪ collision among them.
  it("every heteronym reading maps to IPA no other reading of its word shares or prefixes", () => {
    const collisions: string[] = [];
    for (const word of Object.keys(englishHeteronyms.words)) {
      const alts = Object.entries(readingIpa(word, misakiToIpa)).flatMap(([name, ipa]) => ipa.map((alt) => [name, alt] as const));
      for (const [a, ipaA] of alts) {
        for (const [b, ipaB] of alts) if (a !== b && ipaB.startsWith(ipaA)) collisions.push(`${word}: ${a} ${ipaA} / ${b} ${ipaB}`);
      }
    }
    expect(collisions).toEqual([]);
  });

  it("maps misaki diphthongs to IPA and drops stress", () => {
    expect(readingIpa("live", misakiToIpa)).toEqual({ verb: ["lɪv"], adj: ["laɪv"] });
    expect(readingIpa("row", misakiToIpa)).toEqual({ line: ["ɹoʊ"], quarrel: ["ɹaʊ"] });
  });
});

describe("expandReading", () => {
  it("expands a character class into each literal", () => {
    expect(expandReading("ɹ[əɪi]f")).toEqual(["ɹəf", "ɹɪf", "ɹif"]);
  });

  it("refuses regex syntax it cannot expand", () => {
    expect(() => expandReading("(lɪv|laɪv)")).toThrow(/regex syntax/);
    expect(() => expandReading("ɹ[əɪ")).toThrow(/Unclosed/);
  });
});
