import { describe, it, expect } from "vitest";
import {
  attributeCoverage,
  type IstanbulCoverage,
  type SymbolSpan,
} from "./coverage.js";

const fn = (line: number) => ({ loc: { start: { line }, end: { line: line + 2 } } });

function pct(
  metrics: ReturnType<typeof attributeCoverage>,
  nodeId: string,
): number | undefined {
  return metrics.find((m) => m.nodeId === nodeId && m.name === "coverage_pct")?.value ?? undefined;
}

describe("attributeCoverage", () => {
  const coverage: IstanbulCoverage = {
    "/repo/src/a.ts": {
      fnMap: { "0": fn(2), "1": fn(8) },
      f: { "0": 3, "1": 0 },
    },
    "/repo/src/skip.ts": {
      fnMap: { "0": fn(1) },
      f: { "0": 1 },
    },
  };
  // skip.ts is not a graph node → fileIdOf returns null → excluded.
  const fileIdOf = (abs: string): string | null =>
    abs === "/repo/src/a.ts" ? "src/a.ts" : null;
  const symbolsByFile = new Map<string, SymbolSpan[]>([
    [
      "src/a.ts",
      [
        { id: "src/a.ts#foo", startLine: 1, endLine: 6 },
        { id: "src/a.ts#bar", startLine: 7, endLine: 11 },
      ],
    ],
  ]);

  it("emits per-file coverage % = covered fns / total fns", () => {
    const m = attributeCoverage(coverage, fileIdOf, symbolsByFile);
    expect(pct(m, "src/a.ts")).toBe(50); // fn0 hit, fn1 not → 1/2
  });

  it("attributes each function to its containing symbol by range", () => {
    const m = attributeCoverage(coverage, fileIdOf, symbolsByFile);
    expect(pct(m, "src/a.ts#foo")).toBe(100); // fn at line 2 ∈ [1,6], hit
    expect(pct(m, "src/a.ts#bar")).toBe(0); // fn at line 8 ∈ [7,11], not hit
  });

  it("skips files the graph does not know (fileIdOf → null)", () => {
    const m = attributeCoverage(coverage, fileIdOf, symbolsByFile);
    expect(m.every((x) => !x.nodeId.includes("skip"))).toBe(true);
  });

  it("picks the innermost symbol when spans nest (method inside a class)", () => {
    const cov: IstanbulCoverage = {
      "/repo/c.ts": { fnMap: { "0": fn(5) }, f: { "0": 0 } },
    };
    const syms = new Map<string, SymbolSpan[]>([
      [
        "c.ts",
        [
          { id: "c.ts#Klass", startLine: 1, endLine: 20 }, // outer
          { id: "c.ts#method", startLine: 4, endLine: 8 }, // inner (smaller span)
        ],
      ],
    ]);
    const m = attributeCoverage(cov, (a) => (a === "/repo/c.ts" ? "c.ts" : null), syms);
    expect(pct(m, "c.ts#method")).toBe(0); // attributed to the inner method
    expect(pct(m, "c.ts#Klass")).toBeUndefined(); // not the outer class
  });

  it("rounds file coverage to the nearest percent", () => {
    const cov: IstanbulCoverage = {
      "/repo/r.ts": { fnMap: { "0": fn(1), "1": fn(5), "2": fn(9) }, f: { "0": 1, "1": 1, "2": 0 } },
    };
    const m = attributeCoverage(cov, (a) => (a === "/repo/r.ts" ? "r.ts" : null), new Map());
    expect(pct(m, "r.ts")).toBe(67);
  });

  it("attributes a function starting on a symbol's last line to that symbol", () => {
    const cov: IstanbulCoverage = { "/repo/e.ts": { fnMap: { "0": fn(3) }, f: { "0": 1 } } };
    const syms = new Map<string, SymbolSpan[]>([["e.ts", [{ id: "e.ts#one", startLine: 3, endLine: 3 }]]]);
    const m = attributeCoverage(cov, (a) => (a === "/repo/e.ts" ? "e.ts" : null), syms);
    expect(pct(m, "e.ts#one")).toBe(100);
  });

  it("emits nothing for a file with no functions", () => {
    const cov: IstanbulCoverage = { "/repo/z.ts": { fnMap: {}, f: {} } };
    expect(attributeCoverage(cov, () => "z.ts", new Map())).toEqual([]);
  });
});
