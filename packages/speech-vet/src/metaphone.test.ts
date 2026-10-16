import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { levenshteinDistance, metaphone, phoneticDistance } from "./metaphone.js";
import { sequenceDistance } from "./phones.js";

const Case = z.object({ word: z.string(), code: z.string() });
const Golden = z.object({
  allowedDifferences: z.array(Case.extend({ reason: z.string() })),
  cases: z.array(Case),
});

const golden = Golden.parse(
  JSON.parse(readFileSync(new URL("./fixtures/metaphone.golden.json", import.meta.url), "utf8")),
);

describe("metaphone against jellyfish 1.2.1 (Rust)", () => {
  // Mutation caught: treating a missing character as jellyfish's Python-fallback sentinel "*****"
  // keeps the final b of every -mb word, the k of every -gn word and drops the k of every -gh word.
  it("matches the golden code for every word, apart from the listed differences", () => {
    const allowed = new Map(golden.allowedDifferences.map((d) => [d.word, d.code]));
    const differences = golden.cases
      .filter(({ word, code }) => metaphone(word) !== code)
      .map(({ word }) => ({ word, code: metaphone(word) }));

    expect(golden.cases).toHaveLength(200);
    expect(differences).toEqual(golden.allowedDifferences.map(({ word, code }) => ({ word, code })));
    expect(allowed.size).toBe(golden.allowedDifferences.length);
  });

  it("drops the final consonant of -mb, -gn and -gh words as the Rust build does", () => {
    expect(metaphone("tough")).toBe("TKH");
    expect(metaphone("dumb")).toBe("TM");
    expect(metaphone("sign")).toBe("S");
  });

  it("gives an empty code to digits, and folds long s to s", () => {
    expect(metaphone("50")).toBe("");
    expect(metaphone("ſtop")).toBe("STP");
    expect(metaphone("o'clock")).toBe("OKLK");
  });
});

describe("levenshteinDistance", () => {
  it("counts a single substitution as one", () => {
    expect(levenshteinDistance("TR", "0R")).toBe(1);
  });

  it("is the length of the other side when one side is empty", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
    expect(levenshteinDistance("abc", "")).toBe(3);
    expect(levenshteinDistance("abc", "abc")).toBe(0);
  });
});

describe("phoneticDistance", () => {
  it("is zero for homophones", () => {
    expect(phoneticDistance("their", "there")).toBe(0);
    expect(phoneticDistance("dear", "deer")).toBe(0);
  });

  it("is positive when the codes differ", () => {
    expect(phoneticDistance("aegis", "eejis")).toBeGreaterThan(0);
  });

  it("falls back to character distance when a side has no code", () => {
    expect(phoneticDistance("50", "fifty")).toBe(sequenceDistance("50", "fifty"));
  });
});
