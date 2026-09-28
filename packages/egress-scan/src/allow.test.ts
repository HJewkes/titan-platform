import { describe, expect, it } from "vitest";
import { AllowFileError, globToRegExp, isAllowed, parseAllow } from "./allow.js";

describe("parseAllow", () => {
  it("reads entries and skips comments and blank lines", () => {
    const allow = parseAllow("# why\n\npackages/*/src/**/*.test.ts home-path fixtures use placeholders, TP-405\n");
    expect(allow.entries).toHaveLength(1);
    expect(allow.entries[0]).toMatchObject({ glob: "packages/*/src/**/*.test.ts", rule: "home-path", line: 3 });
  });

  it.each([
    ["no reason", "docs/**.md home-path", /line 1: expected <glob> <rule-id> <reason>/],
    ["no task id in the reason", "docs/**.md home-path documented shape", /line 1: reason must name a task id/],
    ["a private-term entry", "docs/** private-term covered by TP-405", /line 1: private-term is never allowable/],
    ["an unknown rule", "docs/** credentials TP-405", /line 1: unknown rule id/],
  ])("fails an entry with %s", (_label, text, message) => {
    expect(() => parseAllow(text)).toThrow(AllowFileError);
    expect(() => parseAllow(text)).toThrow(message);
  });

  it("fails the whole file when a later line is malformed", () => {
    expect(() => parseAllow("a.md home-path TP-1\nbroken\n")).toThrow(/line 2/);
  });
});

describe("isAllowed", () => {
  const allow = parseAllow("REPORT.md aw-data-path miner path is documented, TP-405");

  it("allows only the named rule in matching files", () => {
    expect(isAllowed(allow, "REPORT.md", "aw-data-path")).toBe(true);
    expect(isAllowed(allow, "REPORT.md", "home-path")).toBe(false);
    expect(isAllowed(allow, "other/REPORT.md", "aw-data-path")).toBe(false);
  });

  it("never allows a private term", () => {
    expect(isAllowed(allow, "REPORT.md", "private-term")).toBe(false);
  });
});

describe("globToRegExp", () => {
  it.each([
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/deep/a.ts", false],
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/deep/er/a.ts", true],
    ["docs/**", "docs/a/b.md", true],
    ["a?.md", "ab.md", true],
    ["a?.md", "a/.md", false],
    ["a.md", "aXmd", false],
  ])("%s against %s is %s", (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
});
