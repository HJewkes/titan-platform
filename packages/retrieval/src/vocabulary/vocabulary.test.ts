import { describe, expect, it } from "vitest";
import { correctQuery, findCorrection, vocabularyFromEntries, type VocabEntry } from "./correct.js";
import { editDistance, maxEditDistance } from "./edit-distance.js";
import { extractTerms, scoreTerm } from "./terms.js";

describe("extractTerms", () => {
  it("extracts lowercase terms from text", () => {
    const terms = extractTerms("Velocity-Based Training fundamentals and methods");
    expect(terms.has("velocity-based")).toBe(true);
    expect(terms.has("training")).toBe(true);
    expect(terms.has("fundamentals")).toBe(true);
    expect(terms.has("methods")).toBe(true);
  });

  it("filters stop words", () => {
    const terms = extractTerms("the quick and the lazy fox");
    expect(terms.has("the")).toBe(false);
    expect(terms.has("and")).toBe(false);
    expect(terms.has("quick")).toBe(true);
    expect(terms.has("lazy")).toBe(true);
  });

  it("filters terms shorter than 3 characters", () => {
    const terms = extractTerms("a is of to in velocity");
    expect(terms.size).toBe(1);
    expect(terms.has("velocity")).toBe(true);
  });

  it("handles empty text", () => {
    expect(extractTerms("").size).toBe(0);
  });

  it("handles identifier-like terms", () => {
    const terms = extractTerms("the BLE_protocol uses snake_case naming");
    expect(terms.has("ble_protocol")).toBe(true);
    expect(terms.has("snake_case")).toBe(true);
    expect(terms.has("naming")).toBe(true);
  });
});

describe("scoreTerm", () => {
  it("assigns higher IDF to rarer terms", () => {
    expect(scoreTerm("rare", 2, 100)).toBeGreaterThan(scoreTerm("common", 50, 100));
  });

  it("gives length bonus for longer terms", () => {
    expect(scoreTerm("abcdefghij", 10, 100)).toBeGreaterThan(scoreTerm("abc", 10, 100));
  });

  it("gives identifier bonus for snake_case terms", () => {
    expect(scoreTerm("snake_case", 10, 100)).toBeGreaterThan(scoreTerm("regular", 10, 100));
  });

  it("handles zero total docs", () => {
    expect(scoreTerm("term", 0, 0)).toBeGreaterThan(0);
  });
});

describe("editDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(editDistance("hello", "hello")).toBe(0);
  });

  it("returns correct distance for substitution", () => {
    expect(editDistance("cat", "bat")).toBe(1);
  });

  it("returns correct distance for insertion", () => {
    expect(editDistance("cat", "cats")).toBe(1);
  });

  it("returns correct distance for deletion", () => {
    expect(editDistance("cats", "cat")).toBe(1);
  });

  it("handles empty strings", () => {
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "")).toBe(3);
    expect(editDistance("", "")).toBe(0);
  });

  it("computes multi-edit distances", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
  });
});

describe("maxEditDistance", () => {
  it("returns 1 for short words (<=4 chars)", () => {
    expect(maxEditDistance(3)).toBe(1);
    expect(maxEditDistance(4)).toBe(1);
  });

  it("returns 2 for medium words (5-12 chars)", () => {
    expect(maxEditDistance(5)).toBe(2);
    expect(maxEditDistance(8)).toBe(2);
    expect(maxEditDistance(12)).toBe(2);
  });

  it("returns 3 for long words (>12 chars)", () => {
    expect(maxEditDistance(13)).toBe(3);
    expect(maxEditDistance(20)).toBe(3);
  });
});

describe("findCorrection", () => {
  const vocab = vocabularyFromEntries([
    { term: "velocity", docFrequency: 10, score: 3.0 },
    { term: "training", docFrequency: 8, score: 2.5 },
    { term: "threshold", docFrequency: 5, score: 3.5 },
    { term: "bluetooth", docFrequency: 3, score: 4.0 },
  ]);

  it("returns exact match unchanged", () => {
    expect(findCorrection("velocity", vocab)).toBe("velocity");
  });

  it("corrects single-character typo", () => {
    expect(findCorrection("velociry", vocab)).toBe("velocity");
  });

  it("corrects two-character typo in long word", () => {
    expect(findCorrection("bluatooth", vocab)).toBe("bluetooth");
  });

  it("returns original when no close match exists", () => {
    expect(findCorrection("xyzzy", vocab)).toBe("xyzzy");
  });

  it("prefers higher-scored term when distances are equal", () => {
    const ambiguous: VocabEntry[] = [
      { term: "fast", docFrequency: 10, score: 1.0 },
      { term: "fist", docFrequency: 2, score: 5.0 },
    ];
    expect(findCorrection("fest", vocabularyFromEntries(ambiguous))).toBe("fist");
  });
});

describe("correctQuery", () => {
  const vocab = vocabularyFromEntries([
    { term: "velocity", docFrequency: 10, score: 3.0 },
    { term: "training", docFrequency: 8, score: 2.5 },
    { term: "bluetooth", docFrequency: 3, score: 4.0 },
  ]);

  it("corrects misspelled terms in a query", () => {
    expect(correctQuery("velociry trainng", vocab)).toEqual({ corrected: "velocity training", didCorrect: true });
  });

  it("preserves correct terms", () => {
    expect(correctQuery("velocity training", vocab)).toEqual({ corrected: "velocity training", didCorrect: false });
  });

  it("preserves short terms without correction", () => {
    const { corrected } = correctQuery("a is velocity", vocab);
    expect(corrected).toContain("a");
    expect(corrected).toContain("is");
  });

  it("handles empty query", () => {
    expect(correctQuery("", vocab)).toEqual({ corrected: "", didCorrect: false });
  });
});
