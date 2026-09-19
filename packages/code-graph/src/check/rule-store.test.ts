import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphMetric, GraphNode } from "../types.js";
import { snapshotViolations, violationKey } from "./check.js";
import type { RuleStore } from "./context.js";

function memoryStore(nodes: GraphNode[], edges: GraphEdge[], metrics: GraphMetric[]): RuleStore {
  return { listNodes: () => nodes, listEdges: () => edges, listMetrics: () => metrics };
}

describe("snapshotViolations over any RuleStore", () => {
  const store = memoryStore(
    [
      { id: "src/a.ts", kind: "file", name: "a.ts" },
      { id: "npm:left-pad", kind: "external", name: "left-pad" },
    ],
    [{ srcId: "src/a.ts", dstId: "npm:left-pad", kind: "imports" }],
    [{ nodeId: "src/a.ts", name: "loc", value: 900 }],
  );

  it("checks a store that only lists nodes, edges, and metrics", () => {
    const violations = snapshotViolations(store, 1, [
      { id: "max-loc", type: "metric-max", metric: "loc", max: 500 },
      { id: "no-pad", type: "forbid-import", from: "src/**", to: "npm:**" },
    ]);

    expect(violations.map(violationKey)).toEqual(["max-loc|src/a.ts", "no-pad|src/a.ts|npm:left-pad"]);
  });
});
