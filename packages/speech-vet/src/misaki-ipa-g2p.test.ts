import { misakiEnglish } from "@titan-design/speech-g2p";
import { describe, expect, it } from "vitest";
import { misakiIpaG2p } from "./misaki-ipa-g2p.js";
import { g2pSentence } from "./phones.js";

const g2p = misakiIpaG2p(misakiEnglish());

function fakeTokens(...phonemes: (string | null)[]) {
  return { tokens: () => phonemes.map((p) => ({ text: "x", tag: "NN", phonemes: p, whitespace: " ", rating: null })) };
}

describe("misakiIpaG2p", () => {
  it("returns stress-free IPA with one whitespace-separated word per token", () => {
    const words = g2pSentence("We live here", { g2p });

    expect(words).toEqual(["wi", "lɪv", "hɪɹ"]);
  });

  it("spells misaki's single-glyph diphthongs as IPA", () => {
    const out = misakiIpaG2p(fakeTokens("hˈA", "kˈO"))("ignored", "en-us");

    expect(out).toBe("heɪ koʊ");
  });

  it("drops a token the lexicon cannot read, as the espeak path drops empty cleaned words", () => {
    const real = g2pSentence("Please check the ruleset today", { g2p });
    const without = g2pSentence("Please check the today", { g2p });

    expect(real).toEqual(without);
  });

  it("yields an empty word for a null-phoneme token and g2pSentence drops it", () => {
    const words = g2pSentence("ignored", { g2p: misakiIpaG2p(fakeTokens("hˈA", null, "kˈO")) });

    expect(words).toEqual(["heɪ", "koʊ"]);
  });

  it("gives a punctuated sentence the words of the unpunctuated one, with no punctuation phones", () => {
    expect(g2pSentence("We live here.", { g2p })).toEqual(g2pSentence("We live here", { g2p }));
    expect(g2pSentence("Wait \u2014 what, really?", { g2p })).toEqual(g2pSentence("Wait what really", { g2p }));
    expect(g2pSentence("\u201cWe live (here)!\u201d", { g2p }).join("")).not.toMatch(/\p{P}/u);
  });

  it("ignores the voice, since misaki reads US English only", () => {
    expect(g2p("We live here", "en-gb")).toBe(g2p("We live here", "en-us"));
  });
});
