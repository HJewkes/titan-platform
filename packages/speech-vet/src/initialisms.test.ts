import { describe, expect, it } from "vitest";
import { spellInitialisms } from "./initialisms.js";

// Ported from the audiobook test_initialisms.py cases.
describe("spellInitialisms", () => {
  // Catches: a period added after the last letter at a sentence end, giving "A. S. A. P.."
  it("asap is spelled out", () => {
    const text = "Bring the form back ASAP.";
    expect(spellInitialisms(text)).toBe("Bring the form back A. S. A. P.");
  });

  // Catches: two-letter tokens treated as words unless allowlisted.
  it("fa is spelled out", () => {
    const text = "the FA has thought about it";
    expect(spellInitialisms(text)).toBe("the F. A. has thought about it");
  });

  // Catches: a quote after the token read as a contraction, so "CA was 'only'" stays unspelled.
  it("ca is spelled out like other stat abbreviations", () => {
    expect(spellInitialisms("Her CA was 'only' 120")).toBe("Her C. A. was 'only' 120");
  });

  // Catches: every vowel-bearing token spelled out, so DOVE and NASA become letters.
  it("word read acronym is left alone", () => {
    const text = "DOVE rates them, and NASA agrees.";
    expect(spellInitialisms(text)).toBe(text);
  });

  // Catches: the shouted two-letter word list dropped, so TO, MY, IT and IS are spelled.
  it("shouted words are left alone", () => {
    const text = "I did NOT say that. TO THE BEST OF MY knowledge, IT IS fine.";
    expect(spellInitialisms(text)).toBe(text);
  });

  // Catches, by case: each branch of isInitialism, the sentence-end rule, the plural suffix and the contraction guard.
  it.each([
    ["the FA Cup", "the F. A. Cup"],
    ["watch TV", "watch T. V."],
    ["GO now", "GO now"],
    ["at 10 PM", "at 10 PM"],
    ["Henry VI", "Henry VI"],
    ["the HTML title", "the H. T. M. L. title"],
    ["on the BBC", "on the B. B. C."],
    ["HMM, maybe", "HMM, maybe"],
    ["the new CEO", "the new C. E. O."],
    ["the MAX update", "the MAX update"],
    ["Is it ASAP?", "Is it A. S. A. P?"],
    ["two CEOs", "two C. E. O's"],
    ["the FA's decision", "the F. A.'s decision"],
    ["I'LL WAIT", "I'LL WAIT"],
    ["WE'VE WON", "WE'VE WON"],
    ["Fa and Tv", "Fa and Tv"],
    ["GOOOAL", "GOOOAL"],
  ])("rule branches: %s", (text, expected) => {
    expect(spellInitialisms(text)).toBe(expected);
  });

  // Catches: the interjection lists dropped, so OK or HMPH is spelled out letter by letter.
  it.each(["OI", "UH", "UM", "AW", "MM", "OK", "HMPH", "GRRR"])("interjections stay words: %s", (interjection) => {
    const text = `${interjection}, you there!`;
    expect(spellInitialisms(text)).toBe(text);
  });

  // The original drove this through the normalizer; T7 ports normalize(). A mid-sentence comma keeps the trailing period.
  // Catches: the sentence-end check reading the character before the match instead of after it.
  it("normalizer spells initialisms end to end", () => {
    const out = spellInitialisms("The FA wants it ASAP, said the CEO.");
    expect(out).toBe("The F. A. wants it A. S. A. P., said the C. E. O.");
  });

  // Catches: the caller's domain list ignored, so a product cannot add its own vowel-bearing initialisms.
  it("spells a caller's domain initialisms without widening the default list", () => {
    const text = "the AMC deal";

    expect([spellInitialisms(text), spellInitialisms(text, { spelled: ["AMC"] })]).toEqual([text, "the A. M. C. deal"]);
  });
});
