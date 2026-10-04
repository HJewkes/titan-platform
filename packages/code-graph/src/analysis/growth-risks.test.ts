import { describe, it, expect } from "vitest";
import type { GraphMetric, GraphNode } from "../types.js";
import { buildReportContext } from "./graph-report-sections.js";
import { topGrowthRisks } from "./growth-risks.js";

const file = (id: string): GraphNode => ({ id, kind: "file", name: id });
const depth = (nodeId: string, value: number): GraphMetric => ({
  nodeId,
  name: "loop_depth",
  value,
  unit: "count",
});

const smell = (nodeId: string, name: string, value: number): GraphMetric => ({
  nodeId,
  name,
  value,
  unit: "count",
});

const nodes: GraphNode[] = [
  file("src/quad.ts"),
  file("src/cubic.ts"),
  file("src/rec.ts"),
  file("src/flat.ts"),
];
const metrics: GraphMetric[] = [
  depth("src/quad.ts", 2),
  smell("src/quad.ts", "search_in_loop", 3),
  depth("src/cubic.ts", 3),
  smell("src/rec.ts", "recursive_functions", 1),
  depth("src/flat.ts", 1),
];

function ctx() {
  return buildReportContext({
    nodes,
    metrics,
    excluders: [],
    excludedRoles: new Set(),
    windowDays: 30,
  });
}

describe("topGrowthRisks (C-66)", () => {
  it("aggregates each file's scaling smells, deepest-loops first", () => {
    const rows = topGrowthRisks(ctx(), 10);
    expect(rows.map((r) => r.nodeId)).toEqual(["src/cubic.ts", "src/quad.ts", "src/rec.ts"]);
    expect(rows.find((r) => r.nodeId === "src/cubic.ts")!.smells).toEqual([
      "cubic-shaped loop nesting",
    ]);
    expect(rows.find((r) => r.nodeId === "src/quad.ts")!.smells).toEqual([
      "quadratic-shaped loop nesting",
      "3 linear searches in loops",
    ]);
    expect(rows.find((r) => r.nodeId === "src/rec.ts")!.smells).toEqual([
      "1 recursive function",
    ]);
  });

  it("does not flag files with no smell (depth-1, no recursion/search)", () => {
    expect(topGrowthRisks(ctx(), 10).map((r) => r.nodeId)).not.toContain("src/flat.ts");
  });
});
