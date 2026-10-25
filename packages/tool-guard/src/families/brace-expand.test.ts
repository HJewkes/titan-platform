import { describe, expect, it } from "vitest";
import { BRACE_EXPANSION_CAP, braceExpansions } from "./brace-expand.js";

describe("braceExpansions, the words bash makes", () => {
  it.each([
    ["a list", "a{b,c}d", ["abd", "acd"]],
    ["an empty item", "delete{,Repository}Ruleset", ["deleteRuleset", "deleteRepositoryRuleset"]],
    ["a nested list", "a{b,c{d,e}}", ["ab", "acd", "ace"]],
    ["two lists", "{a,b}{c,d}", ["ac", "ad", "bc", "bd"]],
    ["a list inside literal braces", "{x{a,b}}", ["{xa}", "{xb}"]],
    ["a list after an unmatched brace", "{a{b,c}", ["{ab", "{ac"]],
    ["an integer sequence", "q{1..3}", ["q1", "q2", "q3"]],
    ["a stepped descending sequence", "{9..1..4}", ["9", "5", "1"]],
    ["a zero-padded sequence", "{08..10}", ["08", "09", "10"]],
    ["a letter sequence", "{a..c}", ["a", "b", "c"]],
  ])("expands %s", (_what, text, words) => {
    expect(braceExpansions(text)).toEqual(words);
  });

  it.each([
    ["a brace with no comma", "{viewer{login}}"],
    ["an empty brace", "a{}b"],
    ["a parameter expansion", "${a,b}"],
    ["a sequence mixing a number and a letter", "{a..5}"],
    ["an unmatched list", "{a,b"],
  ])("leaves %s as written", (_what, text) => {
    expect(braceExpansions(text)).toEqual([text]);
  });
});

describe("braceExpansions, past what it lists", () => {
  it("reads more words than the cap as unknown", () => {
    expect(braceExpansions("{a,b}".repeat(Math.log2(BRACE_EXPANSION_CAP) + 1))).toBeNull();
  });

  it("lists words up to the cap", () => {
    expect(braceExpansions("{a,b}".repeat(Math.log2(BRACE_EXPANSION_CAP)))).toHaveLength(BRACE_EXPANSION_CAP);
  });

  it("reads a sequence too long to list as unknown", () => {
    expect(braceExpansions(`{1..${BRACE_EXPANSION_CAP * 4}}`)).toBeNull();
  });

  it("reads a long text that expands past the text budget as unknown", () => {
    expect(braceExpansions(`{a,b}${"x".repeat(1 << 21)}{c,d}`)).toBeNull();
  });

  it("reads deeply nested literal braces in one pass", () => {
    const text = `${"{".repeat(50_000)}x${"}".repeat(50_000)}`;

    expect(braceExpansions(text)).toEqual([text]);
  });
});
