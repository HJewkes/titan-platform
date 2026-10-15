import { describe, expect, it } from "vitest";
import type { GraphMetric, GraphNode, NodeRole } from "../types.js";
import { complexityDistribution, qualitySection, summarizeComplexity, type CallableComplexity } from "./complexity-distribution.js";
import { buildReportContext } from "./graph-report-sections.js";

function callable(cyclomatic: number, sloc: number, cognitive = 0, fileId = "a.ts"): CallableComplexity {
  return { fileId, cyclomatic, cognitive, sloc };
}

describe("SCBench complexity summary", () => {
  it("matches hand-computed erosion, distribution and Gini for CC [12, 2, 31] over SLOC [9, 4, 16]", () => {
    const summary = summarizeComplexity([callable(12, 9, 10), callable(2, 4, 3), callable(31, 16, 20)]);

    expect(summary.mass).toBe(12 * 3 + 2 * 2 + 31 * 4);
    expect(summary.erosion).toBeCloseTo((12 * 3 + 31 * 4) / (12 * 3 + 2 * 2 + 31 * 4), 10);
    expect(summary.cogMass).toBe(10 * 3 + 3 * 2 + 20 * 4);
    expect(summary.cogErosion).toBeCloseTo((20 * 4) / (10 * 3 + 3 * 2 + 20 * 4), 10);
    expect(summary).toMatchObject({ callables: 3, ccMax: 31, ccMean: 15, ccHighCount: 2, ccExtremeCount: 1, highCcMean: 21.5 });
    expect(summary.ccStd).toBeCloseTo(Math.sqrt(434 / 3), 10);
    expect(summary.ccGini).toBeCloseTo(58 / 135, 10);
  });

  it("counts a callable sitting exactly on the high and extreme cuts as neither", () => {
    const summary = summarizeComplexity([callable(10, 4), callable(30, 4), callable(31, 4)]);

    expect(summary.ccHighCount).toBe(2);
    expect(summary.ccExtremeCount).toBe(1);
    expect(summary.erosion).toBeCloseTo((30 + 31) / (10 + 30 + 31), 10);
  });

  it("reads zero everywhere for no callables and zero concentration for equal ones", () => {
    expect(summarizeComplexity([])).toEqual({
      callables: 0, mass: 0, erosion: 0, cogMass: 0, cogErosion: 0, ccMax: 0, ccMean: 0,
      ccStd: 0, ccHighCount: 0, ccExtremeCount: 0, highCcMean: 0, ccGini: 0,
    });
    expect(summarizeComplexity([callable(4, 1), callable(4, 9)]).ccGini).toBe(0);
  });

  it("finds the highest CC in a tree too large to spread into one call", () => {
    const callables = Array.from({ length: 200_000 }, (_, i) => callable(i === 123_456 ? 99 : 1, 1));

    expect(summarizeComplexity(callables).ccMax).toBe(99);
  });

  it("rolls callables up per package and computes the total over all of them at once", () => {
    const rollup = complexityDistribution(
      [callable(20, 4, 0, "packages/a/x.ts"), callable(2, 4, 0, "packages/b/y.ts"), callable(1, 1, 0, "scripts/z.ts")],
      [{ id: "packages/a", name: "a" }, { id: "packages/b", name: "b" }],
    );

    expect(rollup.packages.map((p) => [p.packageId, p.callables, p.erosion])).toEqual([
      ["", 1, 0],
      ["packages/a", 1, 1],
      ["packages/b", 1, 0],
    ]);
    expect(rollup.total.callables).toBe(3);
    expect(rollup.total.erosion).toBeCloseTo(40 / (40 + 4 + 1), 10);
  });
});

describe("report quality section", () => {
  const file = (id: string, role?: NodeRole): GraphNode => ({ id, kind: "file", name: id, ...(role ? { role } : {}) });
  const symbol = (fileId: string, name: string): GraphNode => ({ id: `${fileId}#${name}`, kind: "symbol", name, parentId: fileId });
  const metric = (nodeId: string, name: string, value: number): GraphMetric => ({ nodeId, name, value });

  it("measures named functions in kept files, taking SLOC from the body's code rows rather than the span less comments", () => {
    const nodes = [file("src/a.ts"), file("src/a.test.ts", "test"), symbol("src/a.ts", "f"), symbol("src/a.ts", "T"), symbol("src/a.test.ts", "t")];
    const ctx = buildReportContext({
      nodes,
      metrics: [
        metric("src/a.ts#f", "symbol_cyclomatic", 12),
        metric("src/a.ts#f", "symbol_cognitive", 15),
        metric("src/a.ts#f", "symbol_loc", 20),
        metric("src/a.ts#f", "symbol_comment_lines", 4),
        metric("src/a.ts#f", "symbol_body_lines", 9),
        metric("src/a.test.ts#t", "symbol_cyclomatic", 40),
      ],
      excluders: [],
      excludedRoles: new Set(["test"]),
      windowDays: 30,
    });

    const { total } = qualitySection(nodes, ctx, [], []).complexity;

    expect(total).toMatchObject({ callables: 1, ccMax: 12, mass: 36, cogMass: 45, erosion: 1, cogErosion: 1 });
  });
});
