import { describe, it, expect } from "vitest";
import type { GraphEdge, GraphMetric, GraphNode } from "../types.js";
import { buildReportContext } from "./graph-report-sections.js";
import { topDeadModules } from "./dead-modules.js";

const file = (id: string, role?: string): GraphNode => ({
  id,
  kind: "file",
  name: id,
  ...(role ? { role: role as GraphNode["role"] } : {}),
});
const edge = (srcId: string, dstId: string, kind: string): GraphEdge => ({
  srcId,
  dstId,
  kind: kind as GraphEdge["kind"],
});
const loc = (nodeId: string, value: number): GraphMetric => ({
  nodeId,
  name: "loc",
  value,
  unit: "lines",
});

const nodes: GraphNode[] = [
  file("src/index.ts", "barrel"),
  file("src/used.ts", "source"),
  file("src/orphan.ts", "source"),
  file("src/deep.ts", "source"),
  file("app/main.tsx", "source"),
  file("app/View.tsx", "source"),
  file("src/thing.test.ts", "test"),
];
const edges: GraphEdge[] = [
  edge("src/index.ts", "src/used.ts", "re-exports"),
  edge("src/orphan.ts", "src/deep.ts", "imports"), // orphan is unreached → deep too
  edge("app/main.tsx", "app/View.tsx", "imports"),
  edge("src/thing.test.ts", "src/used.ts", "imports"),
];
const metrics: GraphMetric[] = [
  loc("src/orphan.ts", 40),
  loc("src/deep.ts", 80),
];

function ctxOf(excluders: RegExp[] = []) {
  return buildReportContext({
    nodes,
    metrics,
    excluders,
    excludedRoles: new Set(),
    windowDays: 30,
  });
}

describe("topDeadModules (C-65)", () => {
  it("flags files unreachable from entry roots, incl. transitively dead chains", () => {
    const rows = topDeadModules(nodes, edges, ctxOf(), 10);
    const ids = rows.map((r) => r.nodeId);
    expect(ids).toContain("src/orphan.ts");
    expect(ids).toContain("src/deep.ts"); // reached only from the dead orphan
  });

  it("treats barrels, tests, and main.* bundler entries as reachable roots", () => {
    const ids = topDeadModules(nodes, edges, ctxOf(), 10).map((r) => r.nodeId);
    expect(ids).not.toContain("src/index.ts"); // barrel root
    expect(ids).not.toContain("src/used.ts"); // re-exported by the barrel
    expect(ids).not.toContain("app/main.tsx"); // main.* entry root
    expect(ids).not.toContain("app/View.tsx"); // imported by the main entry
    expect(ids).not.toContain("src/thing.test.ts"); // test root
  });

  it("ranks by LOC descending (largest unreferenced file first)", () => {
    const rows = topDeadModules(nodes, edges, ctxOf(), 10);
    expect(rows[0]!.nodeId).toBe("src/deep.ts"); // 80 loc > orphan 40
  });

  it("respects --exclude patterns via keepNode", () => {
    const rows = topDeadModules(nodes, edges, ctxOf([/^src\/deep\.ts$/]), 10);
    expect(rows.map((r) => r.nodeId)).not.toContain("src/deep.ts");
  });
});
