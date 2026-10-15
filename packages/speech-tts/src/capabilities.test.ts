import { describe, expect, it } from "vitest";
import { languageMatches, missingCapabilities, requirementsOf } from "./capabilities.js";
import { FAKE_TTS_CAPABILITIES } from "./fake-tts.js";

const TEXT_ONLY = { ...FAKE_TTS_CAPABILITIES, phonemeInput: [], wordTimestamps: false, speedControl: false };

describe("capability matching", () => {
  // Mutation caught: one missing capability short-circuits the rest, so the message names only the first gap.
  it("names every gap between requirements and capabilities", () => {
    const missing = missingCapabilities(TEXT_ONLY, {
      phonemeInput: "misaki",
      wordTimestamps: true,
      speedControl: true,
      voice: "af_heart",
      language: "ja",
      sampleRate: 16_000,
    });

    expect(missing).toEqual([
      "phoneme input (misaki)",
      "word timestamps",
      "speed control",
      'voice "af_heart"',
      'language "ja"',
      "sample rate 16000 Hz",
    ]);
  });

  it("finds nothing missing when nothing is required", () => {
    expect(missingCapabilities(TEXT_ONLY, {})).toEqual([]);
  });

  // Mutation caught: languages compare by primary subtag only, so en-GB matches en-US.
  it("matches a bare language against a regional one, but not two different regions", () => {
    expect(languageMatches(["en"], "en-GB")).toBe(true);
    expect(languageMatches(["en-US"], "en")).toBe(true);
    expect(languageMatches(["en-US"], "en-GB")).toBe(false);
  });

  // Mutation caught: speed 1 is treated as a speed request, so a provider without speed control rejects plain calls.
  it("derives requirements from a call, asking for speed control only off speed 1", () => {
    expect(requirementsOf({ text: "hi" }, "v", { speed: 1 })).toEqual({ voice: "v" });
    expect(requirementsOf({ tokens: [], alphabet: "ipa" }, "v", { speed: 0.9, language: "en" })).toEqual({
      voice: "v",
      phonemeInput: "ipa",
      speedControl: true,
      language: "en",
    });
  });
});
