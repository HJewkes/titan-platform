import { describe, expect, it } from "vitest";
import { applyStress, PRIMARY_STRESS, SECONDARY_STRESS } from "./stress.js";

// Expected values recorded from misaki 0.9.4 `apply_stress`.
describe("applyStress", () => {
  it.each([
    ["kˈætˌɪŋ", -2, "kætɪŋ"],
    ["kˈætˌɪŋ", -1, "kˌætɪŋ"],
    ["kˈæt", -0.5, "kˌæt"],
    ["kæt", -0.5, "kæt"],
    ["ˈkæt", 0, "ˌkæt"],
    ["kæt", 0, "kˌæt"],
    ["kæt", 0.5, "kˌæt"],
    ["kˈæt", 0.5, "kˈæt"],
    ["kˌæt", 1, "kˈæt"],
    ["kæt", 2, "kˈæt"],
  ] as const)("%s at stress %s reads %s", (ps, stress, expected) => {
    expect(applyStress(ps, stress)).toBe(expected);
  });

  it("puts an added mark just before the first vowel, not at the word start or after the vowel", () => {
    expect(applyStress("stɹæt", 2)).toBe(`stɹ${PRIMARY_STRESS}æt`);
    expect(applyStress("stɹæt", 0)).toBe(`stɹ${SECONDARY_STRESS}æt`);
  });

  it("leaves a word with no vowel unmarked", () => {
    expect(applyStress("bt", 2)).toBe("bt");
    expect(applyStress("bt", 0)).toBe("bt");
  });

  it("returns phonemes unchanged when no stress is requested, and null for null phonemes", () => {
    expect(applyStress("kˈætˌɪŋ", null)).toBe("kˈætˌɪŋ");
    expect(applyStress(null, 2)).toBeNull();
  });
});
