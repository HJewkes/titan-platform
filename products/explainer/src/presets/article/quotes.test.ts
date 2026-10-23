import { describe, expect, it } from "vitest";
import { isVerbatim, quoteStates } from "./quotes.js";

describe("claim checks", () => {
  it("matches a quote across line breaks and typographic quotes, but not a changed word", () => {
    expect(isVerbatim("the “diff” only", 'it is the "diff"\n only')).toBe(true);
    expect(isVerbatim("the diff alone", "the diff only")).toBe(false);
  });

  it("finds a number only as a whole number in the quote, with thousands separators", () => {
    expect(quoteStates("from 2.08 to 1.32", 1.32)).toBe(true);
    expect(quoteStates("from 2.08 to 1.32", 1.3)).toBe(false);
    expect(quoteStates("from 2.08 to 11.32", 1.32)).toBe(false);
    expect(quoteStates("Across 1,200 pull requests", 1200)).toBe(true);
    expect(quoteStates("Across 1,200 pull requests", 200)).toBe(false);
  });
});
