import { describe, expect, it } from "vitest";
import { diff, normalize } from "./diff.js";

describe("normalize", () => {
  // Mutation caught: the abbreviation step skipped, so "U.S." becomes "u s".
  it("joins dotted abbreviations and drops sentence punctuation", () => {
    expect(normalize("The U.S. army, again!")).toBe("the us army again");
  });

  // Mutation caught: the compound step skipped, so "well-known" becomes "wellknown".
  it("splits hyphenated compounds into words", () => {
    expect(normalize("A well-known  fact")).toBe("a well known fact");
  });

  // Mutation caught: an ASCII-only word class, so "café" loses its "é".
  it("removes quotes, emphasis and brackets but keeps non-ASCII letters", () => {
    expect(normalize('"*Café*" (_open_) it\'s… “done”')).toBe("café open its done");
  });
});

describe("diff", () => {
  // Mutation caught: the ratio taken over words, not characters, which scores this pair 0.5.
  it("scores character similarity of the normalised texts", () => {
    const result = diff("Hello world.", { text: "hello word" });

    expect(result.similarity).toBeCloseTo((2 * 10) / 21, 12);
    expect(result.passed).toBe(true);
    expect(result.deletions).toEqual(["world"]);
    expect(result.insertions).toEqual(["word"]);
  });

  // Mutation caught: a strict comparison, so a take exactly at the threshold fails.
  it("passes a take whose similarity equals the threshold", () => {
    expect(diff("abcd", "abcx", { threshold: 0.75 }).passed).toBe(true);
  });

  // Mutation caught: the issue text drops the percentages that callers log.
  it("reports a failing similarity and lists at most five missing words", () => {
    const result = diff("one two three four five six seven", "eight");

    expect(result.passed).toBe(false);
    expect(result.issues[0]).toMatch(/^Similarity \d+\.\d% below threshold 90\.0%$/);
    expect(result.deletions).toEqual(["one", "two", "three", "four", "five"]);
    expect(result.issues).toContain("Extra words: eight");
  });
});
