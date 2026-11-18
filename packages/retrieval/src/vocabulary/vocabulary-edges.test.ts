import { describe, expect, it } from "vitest";
import { correctQuery, findCorrection, vocabularyFromEntries, type VocabEntry, type VocabularySource } from "./correct.js";
import { editDistance } from "./edit-distance.js";
import { extractTerms, scoreTerm } from "./terms.js";

describe("editDistance within a band", () => {
  it.each([
    { a: "kitten", b: "sitting", band: 3, expected: 3, why: "distance equal to the band is exact" },
    { a: "kitten", b: "sitting", band: 2, expected: 3, why: "one past the band reads band + 1" },
    { a: "abc", b: "xyz", band: 1, expected: 2, why: "every row past the band stops early" },
    { a: "abc", b: "abcdef", band: 2, expected: 3, why: "a length gap wider than the band" },
    { a: "abc", b: "abcde", band: 2, expected: 2, why: "a length gap equal to the band" },
    { a: "abcdef", b: "fedcba", band: 0, expected: 1, why: "band 0 reads equal or not" },
    { a: "same", b: "same", band: 0, expected: 0, why: "band 0 on equal strings" },
    { a: "", b: "", band: 0, expected: 0, why: "empty against empty" },
    { a: "", b: "ab", band: 2, expected: 2, why: "empty against a string inside the band" },
    { a: "", b: "abc", band: 2, expected: 3, why: "empty against a string past the band" },
  ])("$a vs $b in band $band: $why", ({ a, b, band, expected }) => {
    expect(editDistance(a, b, band)).toBe(expected);
  });

  it("agrees with the unbanded distance whenever that is inside the band", () => {
    const pairs = [["flaw", "lawn"], ["intention", "execution"], ["sunday", "saturday"], ["abcd", "dcba"]] as const;
    for (const [a, b] of pairs) {
      const exact = editDistance(a, b);
      expect(editDistance(a, b, exact)).toBe(exact);
      expect(editDistance(a, b, exact - 1)).toBe(exact);
    }
  });
});

describe("editDistance over unicode", () => {
  it.each([
    { a: "café", b: "cafe", expected: 1, why: "an accented letter is one substitution" },
    { a: "café", b: "café", expected: 0, why: "decomposed and precomposed forms are equal" },
    { a: "a😀b", b: "ab", expected: 1, why: "an astral character is one deletion, not two" },
    { a: "日本語", b: "日本", expected: 1, why: "CJK characters count once each" },
  ])("$a vs $b: $why", ({ a, b, expected }) => {
    expect(editDistance(a, b)).toBe(expected);
  });
});

describe("extractTerms casing and noise", () => {
  it("keeps the first cased form so readLocatorText earns the identifier bonus", () => {
    const terms = extractTerms("Call readLocatorText, then readlocatortext again");
    const cased = terms.get("readlocatortext");
    expect(cased).toBe("readLocatorText");
    expect(scoreTerm(cased ?? "", 3, 50)).toBeCloseTo(scoreTerm("readlocatortext", 3, 50) + 0.5);
  });

  it.each([
    { text: "build 20261114 shipped", dropped: "20261114", why: "a pure number" },
    { text: "commit a3f9c21 landed", dropped: "a3f9c21", why: "a short sha" },
    { text: `a ${"x".repeat(41)} word`, dropped: "x".repeat(41), why: "a term over 40 characters" },
  ])("drops $why", ({ text, dropped }) => {
    expect(extractTerms(text).has(dropped)).toBe(false);
  });

  it("keeps a 40-character term and a hex-letter word with no digit", () => {
    const long = "y".repeat(40);
    const terms = extractTerms(`${long} defaced`);
    expect(terms.has(long)).toBe(true);
    expect(terms.has("defaced")).toBe(true);
  });

  it("extracts letters outside ASCII", () => {
    expect([...extractTerms("Größe naïve 日本語").keys()]).toEqual(["größe", "naïve", "日本語"]);
  });
});

function entry(term: string, score: number): VocabEntry {
  return { term, docFrequency: 1, score };
}

describe("findCorrection ties and edges", () => {
  it.each([
    { entries: [entry("fast", 1), entry("fist", 1)], expected: "fast", why: "equal distance and score go to the earlier term" },
    { entries: [entry("fist", 1), entry("fast", 1)], expected: "fast", why: "regardless of source order" },
    { entries: [entry("fists", 9), entry("feast", 1)], expected: "feast", why: "a smaller distance beats a higher score" },
  ])("$why", ({ entries, expected }) => {
    expect(findCorrection("fest", vocabularyFromEntries(entries))).toBe(expected);
  });

  it("corrects a mixed-case query term to its stored form", () => {
    expect(findCorrection("Velociry", vocabularyFromEntries([entry("velocity", 1)]))).toBe("velocity");
  });

  it("returns a known term as typed, whatever its case", () => {
    expect(findCorrection("Velocity", vocabularyFromEntries([entry("velocity", 1)]))).toBe("Velocity");
  });

  it("asks the source only for lengths within the allowed distance", () => {
    const asked: number[][] = [];
    const source: VocabularySource = {
      has: () => false,
      candidates: (min, max, limit) => (asked.push([min, max, limit]), []),
    };
    findCorrection("velociry", source);
    expect(asked).toEqual([[6, 10, 5000]]);
  });
});

describe("correctQuery bounds", () => {
  it("corrects at most the first 8 eligible words", () => {
    const vocab = vocabularyFromEntries([entry("velocity", 1)]);
    const query = Array.from({ length: 9 }, () => "velociry").join(" ");
    const words = correctQuery(query, vocab).corrected.split(" ");
    expect(words.slice(0, 8).every((word) => word === "velocity")).toBe(true);
    expect(words[8]).toBe("velociry");
  });

  it("collapses runs of whitespace and ignores a whitespace-only query", () => {
    const vocab = vocabularyFromEntries([entry("velocity", 1)]);
    expect(correctQuery("  velociry \t ", vocab)).toEqual({ corrected: "velocity", didCorrect: true });
    expect(correctQuery(" \n ", vocab)).toEqual({ corrected: "", didCorrect: false });
  });
});
