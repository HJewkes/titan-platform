import { describe, expect, it } from "vitest";
import { AllowFileError, isAllowed, parseAllow } from "./allow.js";

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

  it.each(["**", "*", "**/*", "*/**", "*/*.md"])("fails a glob with no literal segment: %s", (glob) => {
    expect(() => parseAllow(`# c\n${glob} home-path TP-1`)).toThrow(/line 2: glob must name at least one literal path segment/);
  });

  it("accepts a glob that names a literal segment", () => {
    expect(parseAllow("packages/**/*.test.ts home-path TP-1").entries).toHaveLength(1);
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

describe("allow globs", () => {
  // The prefix satisfies the literal-segment guard so wildcard-only cases can be matched.
  const matchesGlob = (glob: string, path: string): boolean =>
    isAllowed(parseAllow(`keep/${glob} home-path TP-1 reason`), `keep/${path}`, "home-path");

  it.each([
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/deep/a.ts", false],
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/deep/er/a.ts", true],
    ["docs/**", "docs/a/b.md", true],
    ["a?.md", "ab.md", true],
    ["a?.md", "a/.md", false],
    ["a.md", "aXmd", false],
    ["docs/{a,b}.md", "docs/a.md", true],
    ["docs/{a,b}.md", "docs/b.md", true],
    ["docs/{a,b}.md", "docs/c.md", false],
    ["docs/{a,b}.md", "docs/{a,b}.md", false],
    ["{**,docs}/x.md", "x.md", true],
    ["{**,docs}/x.md", "docs/x.md", true],
    ["{**,docs}/x.md", "other/y.md", false],
    ["docs/{a,{b,c}}.md", "docs/c.md", true],
    ["docs/a{,b}.md", "docs/a.md", true],
    ["docs/a{,b}.md", "docs/ab.md", true],
  ])("%s against %s is %s", (glob, path, expected) => {
    expect(matchesGlob(glob, path)).toBe(expected);
  });

  it.each(["{**,a}", "{*,docs}", "{**,docs}/**", "{,a}", "{a,{**,b}}", "{a,b}{*,c}"])(
    "rejects %s because an alternative has no literal segment",
    (glob) => {
      expect(() => parseAllow(`${glob} home-path TP-1 reason`)).toThrow(AllowFileError);
    },
  );

  it("rejects a glob whose braces expand past the alternative limit", () => {
    const glob = "{a,b,c,d}{a,b,c,d}{a,b,c,d}{a,b,c,d}{a,b}/x.md";
    expect(() => parseAllow(`${glob} home-path TP-1 reason`)).toThrow(AllowFileError);
  });
});
