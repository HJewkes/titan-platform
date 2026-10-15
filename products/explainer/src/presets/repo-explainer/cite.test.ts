import { describe, expect, it } from "vitest";
import { parseCites } from "./cite.js";

describe("parseCites", () => {
  it("reads a range and a single line from prose, in text order", () => {
    expect(parseCites("see a/b.ts:L5-L18 and c.rs:L9")).toEqual([
      { path: "a/b.ts", lineStart: 5, lineEnd: 18 },
      { path: "c.rs", lineStart: 9, lineEnd: 9 },
    ]);
  });

  it("reads a range whose end drops the second L", () => {
    expect(parseCites("x.ts:L5-18")).toEqual([{ path: "x.ts", lineStart: 5, lineEnd: 18 }]);
  });

  it("reads citations inside backticks, parentheses and semicolon lists", () => {
    const text = "(`packages/review/src/source.ts:L40-L52`); .github/workflows/ci.yml:L3; @scope/pkg/index.ts:L1";

    expect(parseCites(text).map((range) => range.path)).toEqual([
      "packages/review/src/source.ts",
      ".github/workflows/ci.yml",
      "@scope/pkg/index.ts",
    ]);
  });

  it("ignores version strings and URLs", () => {
    expect(parseCites("bumped to v1.2:L3 per http://h:L1 and https://github.com/o/r/blob/x.ts:L4")).toEqual([]);
  });

  it("collapses a repeated citation to its first occurrence", () => {
    expect(parseCites("a.ts:L1-L2, b.ts:L3, a.ts:L1-2")).toEqual([
      { path: "a.ts", lineStart: 1, lineEnd: 2 },
      { path: "b.ts", lineStart: 3, lineEnd: 3 },
    ]);
  });

  it("drops a range that ends before it starts or names line zero", () => {
    expect(parseCites("a.ts:L40-L12 b.ts:L0")).toEqual([]);
  });
});
