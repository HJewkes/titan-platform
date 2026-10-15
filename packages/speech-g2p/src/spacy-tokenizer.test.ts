import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadSpacyTokenizerData, placeTokens, spacyTokenizer } from "./spacy-tokenizer.js";

interface GoldenUnit {
  id: string;
  text: string;
  tokens: { text: string; idx: number; ws: string }[];
}

// Only the array is checked; each unit's tokens are compared below.
const hasUnits = (v: unknown): v is { units: GoldenUnit[] } =>
  typeof v === "object" && v !== null && "units" in v && Array.isArray(v.units);
const golden: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/spacy-tokens.golden.json", import.meta.url), "utf8"),
);
if (!hasUnits(golden)) throw new Error("spaCy golden has no units");
const tokenizer = spacyTokenizer();
const texts = (text: string): string[] => tokenizer.tokenize(text).map((t) => t.text);

describe("spacyTokenizer", () => {
  it("matches spaCy on every golden unit: text, offset and whitespace, whitespace tokens included", () => {
    expect(golden.units.length).toBeGreaterThan(400);
    for (const unit of golden.units) {
      const expected = unit.tokens.map(({ text, idx, ws }) => ({ text, idx, whitespace: ws }));

      expect(tokenizer.tokenize(unit.text), unit.id).toEqual(expected);
    }
  });

  it("splits contractions the way spaCy's special cases do", () => {
    expect(texts("I don't know, we can't, they cannot.")).toEqual([
      "I", "do", "n't", "know", ",", "we", "ca", "n't", ",", "they", "can", "not", ".",
    ]);
  });

  it("keeps St. whole before a name, splits $5, and keeps a hyphen as an infix token", () => {
    expect(texts("St. Louis costs $5 for well-known co-ops.")).toEqual([
      "St.", "Louis", "costs", "$", "5", "for", "well", "-", "known", "co", "-", "ops", ".",
    ]);
  });

  it("gives a run of spaces past the first, and any other whitespace run, a token of its own", () => {
    expect(tokenizer.tokenize("  a   b\n c ")).toEqual([
      { text: "  ", idx: 0, whitespace: "" },
      { text: "a", idx: 2, whitespace: " " },
      { text: "  ", idx: 4, whitespace: "" },
      { text: "b", idx: 6, whitespace: "" },
      { text: "\n ", idx: 7, whitespace: "" },
      { text: "c", idx: 9, whitespace: " " },
    ]);
  });

  it("counts offsets in code points, as Python does, past an astral character", () => {
    expect(tokenizer.tokenize("𝔸 don't").map((t) => [t.text, t.idx])).toEqual([
      ["𝔸", 0],
      ["do", 2],
      ["n't", 4],
    ]);
  });

  it("rejoins a special case that affix splitting broke apart, as spaCy's phrase matcher does", () => {
    const data = loadSpacyTokenizerData();
    const rules = Object.fromEntries(Object.entries(data.rules).filter(([key]) => key !== "(:"));
    const withoutRule = spacyTokenizer({ ...data, rules });

    expect(texts("(:word")).toEqual(["(:", "word"]);
    expect(withoutRule.tokenize("(:word").map((t) => t.text)).toEqual(["(", ":", "word"]);
  });

  it("refuses tokens that do not cover the text", () => {
    expect(() => placeTokens("ab cd", ["ab", "ce"])).toThrow(/not found/);
  });
});
