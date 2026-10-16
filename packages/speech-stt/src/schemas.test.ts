import { describe, expect, it } from "vitest";
import { TranscriptSchema, WordSchema } from "./schemas.js";

describe("schemas", () => {
  // Mutation caught: probability made required, which rejects backends that do not report it.
  it("accepts a word without a probability and a transcript with segment confidences", () => {
    const transcript = {
      text: "hi there",
      words: [{ text: "hi", start: 0, end: 0.2 }, { text: "there", start: 0.3, end: 0.6, probability: 0.9 }],
      segments: [{ text: "hi there", start: 0, end: 0.6, avgLogprob: -0.2, compressionRatio: 1.1, noSpeechProb: 0.01 }],
    };

    expect(TranscriptSchema.parse(transcript)).toEqual(transcript);
  });

  // Mutation caught: times typed loosely, so whisper's string-typed seconds slip through.
  it("rejects a word whose times are not numbers", () => {
    expect(WordSchema.safeParse({ text: "hi", start: "0", end: 0.2 }).success).toBe(false);
  });
});
