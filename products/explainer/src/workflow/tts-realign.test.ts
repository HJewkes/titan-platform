import { describe, expect, it } from "vitest";
import { realign } from "./tts-realign.js";

const heard = (...words: [string, number, number][]) => words.map(([word, start, end]) => ({ word, start, end }));

describe("realign", () => {
  it("anchors a number word the engine wrote as digits to the digits' time", () => {
    const words = realign(["it", "took", "thirteen", "days"], heard(["it", 0, 0.2], ["took", 0.2, 0.5], ["13", 0.5, 1.1], ["days", 1.1, 1.5]));

    expect(words[2]).toEqual({ word: "thirteen", start: 0.5, end: 1.1 });
  });

  it("gives a hyphenated word the span of all its heard parts", () => {
    const words = realign(["a", "well-known", "gate"], heard(["a", 0, 0.1], ["well", 0.1, 0.4], ["known", 0.4, 0.8], ["gate", 0.8, 1.2]));

    expect(words[1]).toEqual({ word: "well-known", start: 0.1, end: 0.8 });
    expect(words[2]).toEqual({ word: "gate", start: 0.8, end: 1.2 });
  });

  it("matches a homophone from the lexicon to the script's word", () => {
    const words = realign(["three", "cribs"], heard(["three", 0, 0.3], ["crips", 0.3, 0.9]), { crips: "cribs" });

    expect(words[1]).toEqual({ word: "cribs", start: 0.3, end: 0.9 });
  });

  it("spreads a run of unmatched words evenly over the gap between its neighbours", () => {
    const words = realign(["the", "zork", "blip", "gate"], heard(["the", 0, 0.2], ["xx", 0.2, 0.4], ["gate", 1.0, 1.4]));

    expect(words.slice(1, 3)).toEqual([{ word: "zork", start: 0.2, end: 0.6 }, { word: "blip", start: 0.6, end: 1 }]);
  });
});
