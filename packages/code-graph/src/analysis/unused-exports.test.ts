import { describe, it, expect } from "vitest";
import type { GraphEdge, GraphMetric, GraphNode } from "../types.js";
import { buildReportContext } from "./graph-report-sections.js";
import { publicApiFiles, topUnusedExports } from "./unused-exports.js";

const file = (id: string, role?: string): GraphNode => ({
  id,
  kind: "file",
  name: id,
  ...(role ? { role: role as GraphNode["role"] } : {}),
});
const sym = (file: string, name: string, exported: boolean): GraphNode => ({
  id: `${file}#${name}`,
  kind: "symbol",
  name,
  parentId: file,
  attrs: { exported },
});
const util = (nodeId: string, value: number): GraphMetric => ({
  nodeId,
  name: "utilization",
  value,
  unit: "count",
});
const symLoc = (nodeId: string, value: number): GraphMetric => ({
  nodeId,
  name: "symbol_loc",
  value,
  unit: "count",
});
const cx = (nodeId: string, value: number): GraphMetric => ({
  nodeId,
  name: "symbol_cognitive",
  value,
  unit: "count",
});

function ctxOf(nodes: GraphNode[], metrics: GraphMetric[]) {
  return buildReportContext({
    nodes,
    metrics,
    excluders: [],
    excludedRoles: new Set(),
    windowDays: 30,
  });
}

describe("topUnusedExports (C-65)", () => {
  const nodes: GraphNode[] = [
    file("src/a.ts"),
    file("src/pub.ts"),
    file("src/index.ts", "barrel"),
  ];
  const symbols: GraphNode[] = [
    sym("src/a.ts", "used", true),
    sym("src/a.ts", "dead", true),
    sym("src/a.ts", "internalHelper", false), // non-exported → never listed
    sym("src/pub.ts", "apiExport", true),
  ];
  const metrics: GraphMetric[] = [
    util("src/a.ts#used", 5),
    util("src/a.ts#dead", 0),
    util("src/a.ts#internalHelper", 0),
    util("src/pub.ts#apiExport", 0),
    cx("src/a.ts#dead", 8),
    cx("src/pub.ts#apiExport", 3),
  ];
  // index.ts (barrel) re-exports from pub.ts → pub.ts exports are public API.
  const edges: GraphEdge[] = [
    { srcId: "src/index.ts", dstId: "src/pub.ts", kind: "re-exports" },
  ];

  it("flags exported symbols with zero utilization, skipping used and non-exported", () => {
    const ctx = ctxOf(nodes, metrics);
    const rows = topUnusedExports(symbols, publicApiFiles(nodes, edges), ctx, 10);
    const names = rows.map((r) => r.name);
    expect(names).toContain("dead");
    expect(names).toContain("apiExport");
    expect(names).not.toContain("used"); // utilization > 0
    expect(names).not.toContain("internalHelper"); // not exported
  });

  it("splits confidence: barrel-reexported files are public API", () => {
    const ctx = ctxOf(nodes, metrics);
    const rows = topUnusedExports(symbols, publicApiFiles(nodes, edges), ctx, 10);
    const dead = rows.find((r) => r.name === "dead");
    const api = rows.find((r) => r.name === "apiExport");
    expect(dead?.publicApi).toBe(false);
    expect(api?.publicApi).toBe(true);
  });

  it("ranks internal (higher-confidence) exports before public-API ones", () => {
    const ctx = ctxOf(nodes, metrics);
    const rows = topUnusedExports(symbols, publicApiFiles(nodes, edges), ctx, 10);
    // `dead` (internal) leads `apiExport` (public API) despite complexity order.
    expect(rows[0]!.name).toBe("dead");
  });

  it("reads the export's own loc, and 0 when unmeasured", () => {
    const ctx = ctxOf(nodes, [...metrics, symLoc("src/a.ts#dead", 14)]);
    const rows = topUnusedExports(symbols, publicApiFiles(nodes, edges), ctx, 10);
    expect(rows.find((r) => r.name === "dead")?.loc).toBe(14);
    expect(rows.find((r) => r.name === "apiExport")?.loc).toBe(0);
  });

  it("respects excluded files via keepNode", () => {
    const ctx = buildReportContext({
      nodes,
      metrics,
      excluders: [/^src\/a\.ts$/],
      excludedRoles: new Set(),
      windowDays: 30,
    });
    const rows = topUnusedExports(symbols, publicApiFiles(nodes, edges), ctx, 10);
    expect(rows.map((r) => r.name)).not.toContain("dead");
  });

  it("excludes exports declared in generated files (C-73)", () => {
    const genNodes: GraphNode[] = [file("src/client.gen.ts", "generated")];
    const genSymbols: GraphNode[] = [sym("src/client.gen.ts", "createClient", true)];
    const genMetrics: GraphMetric[] = [
      util("src/client.gen.ts#createClient", 0),
      cx("src/client.gen.ts#createClient", 9),
    ];
    const ctx = ctxOf(genNodes, genMetrics);
    const rows = topUnusedExports(genSymbols, new Set(), ctx, 10);
    expect(rows).toHaveLength(0);
  });
});
