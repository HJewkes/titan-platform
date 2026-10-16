import { describe, expect, it } from "vitest";
import { matchPattern, patternsOverlap } from "./glob-pattern.js";

describe("matchPattern", () => {
  it.each([
    ["src/a.ts", "src/a.ts", true],
    ["src/a.ts", "src/b.ts", false],
    ["src/cli/a.ts", "src/", true],
    ["src", "src/", true],
    ["src/a.ts", "src/*.ts", true],
    ["src/cli/a.ts", "src/*.ts", false],
    ["src/cli/a.ts", "src/**", true],
    ["src/cli/a.ts", "src/**/a.ts", true],
    ["src/a.ts", "src/**/a.ts", true],
    ["src.ts", "src*ts", true],
  ])("matches %s against %s: %s", (file, pattern, expected) => {
    expect(matchPattern(file, pattern)).toBe(expected);
  });
});

describe("patternsOverlap", () => {
  it("catches a subtree pattern covering a concrete file", () => {
    expect(patternsOverlap("src/**", "src/cli/foo.ts")).toBe(true);
  });

  it("catches two subtree patterns where one contains the other", () => {
    expect(patternsOverlap("src/**", "src/cli/**")).toBe(true);
  });

  it("leaves separate subtrees and sibling files alone", () => {
    expect(patternsOverlap("src/cli/**", "src/broker/**")).toBe(false);
    expect(patternsOverlap("src/cli/a.ts", "src/cli/b.ts")).toBe(false);
  });

  it.each(["?", "a?.md", "[ab].md", "{a,b}.md"])("reads %s as a literal file name, not a wildcard", (pattern) => {
    expect(patternsOverlap(pattern, "a.md")).toBe(false);
    expect(patternsOverlap(pattern, pattern)).toBe(true);
  });

  it("decides wildcard pairs exactly, so different segment counts never overlap", () => {
    expect(patternsOverlap("src/*.ts", "src/a*/b.ts")).toBe(false);
    expect(patternsOverlap("*.md", "*/x.md")).toBe(false);
    expect(patternsOverlap("*", "docs/")).toBe(false);
  });

  it.each([
    ["pkg/src/config*.ts", "pkg/src/gate-resolve-round*"],
    ["pkg/src/config*.ts", "pkg/src/cli.ts"],
    ["packages/workflow/src/types.ts", "packages/style-*/src/**"],
  ])("accepts the disjoint glob pair %s and %s", (a, b) => {
    expect(patternsOverlap(a, b)).toBe(false);
  });

  it("counts two star segments with agreeing heads and tails as overlapping", () => {
    expect(patternsOverlap("src/a*.ts", "src/ab*.ts")).toBe(true);
  });

  it("reports an undecided ** inside a longer segment as an overlap", () => {
    expect(patternsOverlap("src/a**b/x.ts", "lib/*")).toBe(true);
  });
});
