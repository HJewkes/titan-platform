import { describe, expect, it } from "vitest";
import { misakiToIpa } from "./misaki-to-ipa.js";

describe("misakiToIpa", () => {
  it.each([
    ["A", "eɪ"],
    ["I", "aɪ"],
    ["O", "oʊ"],
    ["W", "aʊ"],
    ["Y", "ɔɪ"],
    ["Q", "əʊ"],
    ["T", "ɾ"],
    ["ᵊ", "ə"],
    ["ᵻ", "ɪ"],
    ["ʤ", "dʒ"],
    ["ʧ", "tʃ"],
  ])("maps %s to %s", (misaki, ipa) => {
    expect(misakiToIpa(misaki)).toBe(ipa);
  });

  it("keeps stress marks by default", () => {
    expect(misakiToIpa("lˈIv")).toBe("lˈaɪv");
    expect(misakiToIpa("ˌAbˈO", { stress: "keep" })).toBe("ˌeɪbˈoʊ");
  });

  it("strips stress marks on request", () => {
    expect(misakiToIpa("ˌAbˈO", { stress: "strip" })).toBe("eɪboʊ");
  });

  it("leaves plain IPA symbols untouched", () => {
    expect(misakiToIpa("ðə")).toBe("ðə");
  });

  it("keeps a diphthong reading distinct from its short-vowel twin", () => {
    // A mutation swapping I for ɪ would collapse these two.
    expect(misakiToIpa("lˈIv")).not.toBe(misakiToIpa("lˈɪv"));
    expect(misakiToIpa("A")).not.toBe(misakiToIpa("I"));
  });
});
