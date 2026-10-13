import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphMetric, GraphNode, NodeRole } from "../types.js";
import { qualitySection } from "./complexity-distribution.js";
import { callGraphMetrics, dependencyGraphMetrics, importCyclicMass } from "./dependency-graph-metrics.js";
import { buildReportContext } from "./graph-report-sections.js";

const link = (src: string, dst: string, weight = 1) => ({ src, dst, weight });
const file = (id: string, role?: NodeRole): GraphNode => ({ id, kind: "file", name: id, ...(role ? { role } : {}) });
const symbol = (fileId: string, name: string): GraphNode => ({ id: `${fileId}#${name}`, kind: "symbol", name, parentId: fileId });
const calls = (srcId: string, dstId: string, sites = 1): GraphEdge => ({
  srcId, dstId, kind: "calls", attrs: { sites: Array.from({ length: sites }, () => ({ args: [] })) },
});

describe("SCBench call-graph metrics", () => {
  it("matches hand-computed CY, PC and ENT for a 3-callable cycle with a tail that calls itself", () => {
    const links = [link("a", "b", 2), link("b", "c"), link("c", "a"), link("c", "d", 3), link("d", "d")];

    const m = callGraphMetrics(["a", "b", "c", "d"], links);

    expect(m).toMatchObject({ nodes: 4, edges: 5 });
    expect(m.cyclicDependencyMass).toBeCloseTo(4 / 8, 10);
    expect(m.propagationCost).toBeCloseTo(9 / 12, 10);
    const cEntropy = -(0.25 * Math.log(0.25) + 0.75 * Math.log(0.75)) / Math.log(2);
    expect(m.dependencyEntropy).toBeCloseTo(cEntropy / 4, 10);
  });

  it("gives an even fan-out full entropy and an empty graph zeros", () => {
    expect(callGraphMetrics(["a", "b", "c"], [link("a", "b", 5), link("a", "c", 5)]).dependencyEntropy).toBeCloseTo(1 / 3, 10);
    expect(callGraphMetrics([], [])).toEqual({ nodes: 0, edges: 0, cyclicDependencyMass: 0, propagationCost: 0, dependencyEntropy: 0 });
  });
});

describe("cyclic import mass", () => {
  it("splits cyclic weight into what value imports close and what only a type-only import closes", () => {
    const value = (src: string, dst: string, weight: number) => ({ ...link(src, dst, weight), typeOnly: false });
    const links = [value("x", "y", 1), value("y", "x", 1), value("y", "z", 2), { ...link("z", "y"), typeOnly: true }, value("w", "x", 5)];

    expect(importCyclicMass(["w", "x", "y", "z"], links)).toEqual({ value: 0.2, typeOnly: 0.3 });
  });
});

describe("dependency rows per package", () => {
  it("weights calls by site count and ignores edges that leave the package", () => {
    const nodes = [symbol("packages/a/x.ts", "f"), symbol("packages/a/x.ts", "g"), symbol("packages/b/y.ts", "h")];
    const edges = [
      calls("packages/a/x.ts#f", "packages/a/x.ts#g", 3),
      calls("packages/a/x.ts#g", "packages/a/x.ts#f"),
      calls("packages/a/x.ts#g", "packages/b/y.ts#h"),
    ];

    const rows = dependencyGraphMetrics(nodes, edges, [{ id: "packages/a", name: "a" }, { id: "packages/b", name: "b" }]);

    expect(rows.map((r) => [r.packageId, r.calls.nodes, r.calls.edges, r.calls.cyclicDependencyMass])).toEqual([
      ["packages/a", 2, 2, 1],
      ["packages/b", 1, 0, 0],
    ]);
  });

  it("builds the report's graphs from measured callables and kept files only", () => {
    const nodes = [file("src/a.ts"), file("src/a.test.ts", "test"), symbol("src/a.ts", "f"), symbol("src/a.ts", "g"), symbol("src/a.test.ts", "t")];
    const metric = (nodeId: string): GraphMetric => ({ nodeId, name: "symbol_cyclomatic", value: 1 });
    const ctx = buildReportContext({
      nodes,
      metrics: [metric("src/a.ts#f"), metric("src/a.ts#g"), metric("src/a.test.ts#t")],
      excluders: [],
      excludedRoles: new Set(["test"]),
      windowDays: 30,
    });
    const edges: GraphEdge[] = [
      calls("src/a.ts#f", "src/a.ts#g"),
      calls("src/a.test.ts#t", "src/a.ts#f"),
      { srcId: "src/a.test.ts", dstId: "src/a.ts", kind: "imports", attrs: { weight: 1 } },
    ];

    const [row] = qualitySection(nodes, ctx, [], edges).dependencies;

    expect(row).toMatchObject({ packageId: "", calls: { nodes: 2, edges: 1, propagationCost: 0.5 }, imports: { value: 0, typeOnly: 0 } });
  });
});
