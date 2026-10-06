import { describe, expect, it } from "vitest";
import { compilePatterns } from "../check/patterns.js";
import type { GraphEdge, GraphMetric, GraphNode, NodeRole } from "../types.js";
import {
  buildReportContext,
  busFactorOf,
  hotspotComplexityOf,
  hotspotScoreOf,
  topBusFactorRisks,
  topCentralFiles,
  topHotspots,
  topTestCoverageRisks,
  type ReportContextInput,
} from "./graph-report-sections.js";

function file(id: string, role?: NodeRole): GraphNode {
  return { id, kind: "file", name: id, ...(role ? { role } : {}) };
}

function metric(nodeId: string, name: string, value: number | null): GraphMetric {
  return { nodeId, name, value };
}

function context(overrides: Partial<ReportContextInput>) {
  return buildReportContext({
    nodes: [],
    metrics: [],
    excluders: [],
    excludedRoles: new Set(),
    windowDays: 30,
    ...overrides,
  });
}

describe("hotspots", () => {
  it("ranks files by churn × complexity, preferring cognitive over cyclomatic", () => {
    const ctx = context({
      nodes: [file("a.ts"), file("b.ts"), file("c.ts")],
      metrics: [
        metric("a.ts", "churn_30d", 100),
        metric("a.ts", "cyclomatic_max", 5),
        metric("a.ts", "cognitive_max", 30),
        metric("b.ts", "churn_30d", 50),
        metric("b.ts", "cognitive_max", 80),
        metric("c.ts", "churn_30d", 200),
        metric("c.ts", "cognitive_max", 10),
      ],
    });

    const rows = topHotspots(ctx, 3);

    expect(rows.map((r) => [r.nodeId, r.score])).toEqual([
      ["b.ts", 4000],
      ["a.ts", 3000],
      ["c.ts", 2000],
    ]);
  });

  it("falls back to cyclomatic_max when no cognitive metric is stored", () => {
    const ctx = context({
      nodes: [file("a.ts")],
      metrics: [metric("a.ts", "churn_30d", 10), metric("a.ts", "cyclomatic_max", 4)],
    });

    expect(topHotspots(ctx, 5)).toEqual([
      { nodeId: "a.ts", churn: 10, complexity: 4, recency: 1, score: 40 },
    ]);
  });

  it("discounts a young file by its recency factor for the window", () => {
    const ctx = context({
      nodes: [file("new.ts")],
      metrics: [
        metric("new.ts", "churn_30d", 10),
        metric("new.ts", "cognitive_max", 10),
        metric("new.ts", "recency_30d", 0.25),
      ],
    });

    expect(topHotspots(ctx, 5)[0]?.score).toBe(25);
    expect(hotspotScoreOf(ctx, "new.ts")).toBe(25);
  });

  it("reads the lifetime window's metrics when the window is lifetime", () => {
    const ctx = context({
      nodes: [file("a.ts")],
      metrics: [
        metric("a.ts", "churn_30d", 1),
        metric("a.ts", "churn_lifetime", 7),
        metric("a.ts", "cognitive_max", 3),
      ],
      windowDays: "lifetime",
    });

    expect(topHotspots(ctx, 5)[0]?.churn).toBe(7);
  });

  it("skips generated, excluded-role, excluded-pattern and non-file nodes", () => {
    const nodes: GraphNode[] = [
      file("keep.ts", "source"),
      file("client.gen.ts", "generated"),
      file("a.test.ts", "test"),
      file("vendor/x.ts", "source"),
      { id: "keep.ts#fn", kind: "symbol", name: "fn" },
    ];
    const metrics = nodes.flatMap((n) => [metric(n.id, "churn_30d", 5), metric(n.id, "cognitive_max", 5)]);
    const ctx = context({
      nodes,
      metrics,
      excluders: compilePatterns(["vendor/**"]),
      excludedRoles: new Set(["test"]),
    });

    expect(topHotspots(ctx, 10).map((r) => r.nodeId)).toEqual(["keep.ts"]);
    expect(hotspotScoreOf(ctx, "client.gen.ts")).toBe(0);
  });

  it("ignores null metric values and scores a file with no churn as zero", () => {
    const ctx = context({
      nodes: [file("a.ts")],
      metrics: [metric("a.ts", "churn_30d", null), metric("a.ts", "cognitive_max", 9)],
    });

    expect(topHotspots(ctx, 5)).toEqual([]);
    expect(hotspotScoreOf(ctx, "a.ts")).toBe(0);
  });

  it("reads a file's complexity factor with or without churn, and undefined when unmeasured", () => {
    const ctx = context({
      nodes: [file("a.ts"), file("b.ts"), file("c.ts")],
      metrics: [metric("a.ts", "cyclomatic_max", 5), metric("a.ts", "cognitive_max", 30), metric("b.ts", "cognitive_max", 9)],
    });

    expect([hotspotComplexityOf(ctx, "a.ts"), hotspotComplexityOf(ctx, "b.ts"), hotspotComplexityOf(ctx, "c.ts")]).toEqual([30, 9, undefined]);
  });
});

describe("ownership risks", () => {
  it("lists single-owner files ordered by churn, defaulting a missing share to 1", () => {
    const ctx = context({
      nodes: [file("a.ts"), file("b.ts"), file("c.ts")],
      metrics: [
        metric("a.ts", "bus_factor_30d", 1),
        metric("a.ts", "churn_30d", 5),
        metric("b.ts", "bus_factor_30d", 1),
        metric("b.ts", "churn_30d", 20),
        metric("b.ts", "top_author_share_30d", 0.9),
        metric("c.ts", "bus_factor_30d", 3),
        metric("c.ts", "churn_30d", 99),
      ],
    });

    expect(topBusFactorRisks(ctx, 5)).toEqual([
      { nodeId: "b.ts", busFactor: 1, topAuthorShare: 0.9, churn: 20 },
      { nodeId: "a.ts", busFactor: 1, topAuthorShare: 1, churn: 5 },
    ]);
    expect(busFactorOf(ctx, "c.ts")).toBe(3);
    expect(busFactorOf(ctx, "missing.ts")).toBeUndefined();
  });

  it("lists sources whose tests have one owner, ordered by linked test count", () => {
    const ctx = context({
      nodes: [file("a.ts"), file("b.ts")],
      metrics: [
        metric("a.ts", "test_bus_factor_30d", 1),
        metric("a.ts", "linked_test_count", 1),
        metric("b.ts", "test_bus_factor_30d", 1),
        metric("b.ts", "test_top_author_share_30d", 0.8),
        metric("b.ts", "linked_test_count", 3),
      ],
    });

    expect(topTestCoverageRisks(ctx, 5)).toEqual([
      { nodeId: "b.ts", testBusFactor: 1, testTopAuthorShare: 0.8, linkedTests: 3 },
      { nodeId: "a.ts", testBusFactor: 1, testTopAuthorShare: 1, linkedTests: 1 },
    ]);
  });
});

describe("central files", () => {
  it("ranks the most-imported file first and stops at the limit", () => {
    const nodes = [file("hub.ts"), file("a.ts"), file("b.ts"), file("gen.ts", "generated")];
    const edges: GraphEdge[] = [
      { srcId: "a.ts", dstId: "hub.ts", kind: "imports" },
      { srcId: "b.ts", dstId: "hub.ts", kind: "imports" },
      { srcId: "gen.ts", dstId: "hub.ts", kind: "imports" },
    ];
    const ctx = context({ nodes });

    const rows = topCentralFiles(nodes, edges, ctx, 2);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.nodeId).toBe("hub.ts");
    expect(rows.map((r) => r.nodeId)).not.toContain("gen.ts");
  });
});
