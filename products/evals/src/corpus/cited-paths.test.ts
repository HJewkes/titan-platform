import { describe, expect, it } from "vitest";
import { citedPaths, citesPath } from "./cited-paths.js";

describe("citedPaths", () => {
  it("reads file paths with or without a line, and extensionless paths in backticks", () => {
    const text = "In `src/seats/in-flight.ts` (line 40) and src/x/y.tsx:12-20, plus `.github/CODEOWNERS` and `src/agents/`.";
    expect(citedPaths(text)).toEqual([".github/CODEOWNERS", "src/agents/", "src/seats/in-flight.ts", "src/x/y.tsx"]);
  });

  it("skips URLs, versions and plain words", () => {
    expect(citedPaths("See https://example.invalid/a/b.ts, release 0.18.1, e.g. the fix.")).toEqual([]);
  });
});

describe("citesPath", () => {
  it("matches a cited file tail or directory against a full changed path", () => {
    expect(citesPath("in-flight.ts", "src/seats/in-flight.ts")).toBe(true);
    expect(citesPath("flight.ts", "src/seats/in-flight.ts")).toBe(false);
    expect(citesPath("src/agents/", "packages/x/src/agents/a.ts")).toBe(true);
  });
});
