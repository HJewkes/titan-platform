import { describe, expect, it } from "vitest";
import { openCodeGraph, type CodeGraphStore } from "./store.js";
import { prepareTargetedStatements, type TargetedStatements } from "./store-reads.js";

function seededStore(): { store: CodeGraphStore; snapshotId: number } {
  const store = openCodeGraph(":memory:");
  const other = store.createSnapshot({ ref: "old", indexVersion: "0.14.0" });
  store.insertNodes(other, [{ id: "a.ts", kind: "file", name: "a.ts" }]);
  store.insertMetrics(other, [{ nodeId: "a.ts", name: "loc", value: 999, unit: "lines" }]);
  store.insertEdges(other, [{ srcId: "a.ts", dstId: "b.ts", kind: "imports" }]);

  const snapshotId = store.createSnapshot({ ref: "head", indexVersion: "0.14.0" });
  store.insertNodes(snapshotId, [
    { id: "a.ts", kind: "file", name: "a.ts" },
    { id: "b.ts", kind: "file", name: "b.ts" },
    { id: "b.ts#run", kind: "symbol", name: "run", parentId: "b.ts" },
    { id: "npm:zod", kind: "external", name: "zod" },
  ]);
  store.insertEdges(snapshotId, [
    { srcId: "a.ts", dstId: "b.ts", kind: "imports", attrs: { weight: 2 } },
    { srcId: "b.ts", dstId: "npm:zod", kind: "imports" },
    { srcId: "a.ts", dstId: "b.ts#run", kind: "references" },
    { srcId: "b.ts", dstId: "b.ts", kind: "imports" },
  ]);
  store.insertMetrics(snapshotId, [
    { nodeId: "a.ts", name: "loc", value: 10, unit: "lines" },
    { nodeId: "b.ts", name: "loc", value: 30, unit: "lines" },
    { nodeId: "b.ts", name: "fan_in", value: 1, unit: "count" },
    { nodeId: "b.ts#run", name: "utilization", value: 4, unit: "count" },
    { nodeId: "npm:zod", name: "utilization", value: null, unit: "count" },
  ]);
  return { store, snapshotId };
}

describe("listMetricsForNode", () => {
  it("returns only the named node's metrics in the named snapshot", () => {
    const { store, snapshotId } = seededStore();
    const metrics = store.listMetricsForNode(snapshotId, "b.ts");
    expect(metrics.map((m) => [m.name, m.value]).sort()).toEqual([["fan_in", 1], ["loc", 30]]);
    expect(store.listMetricsForNode(snapshotId, "a.ts")).toEqual([{ nodeId: "a.ts", name: "loc", value: 10, unit: "lines" }]);
    expect(store.listMetricsForNode(snapshotId, "missing.ts")).toEqual([]);
  });

  it("matches the whole-snapshot read filtered to the node", () => {
    const { store, snapshotId } = seededStore();
    const filtered = store.listMetrics(snapshotId).filter((m) => m.nodeId === "b.ts");
    expect(store.listMetricsForNode(snapshotId, "b.ts")).toEqual(expect.arrayContaining(filtered));
  });
});

describe("listEdgesTouching", () => {
  it("returns inbound and outbound edges, a self-loop once, and hides references by default", () => {
    const { store, snapshotId } = seededStore();
    const edges = store.listEdgesTouching(snapshotId, "b.ts");
    const keys = edges.map((e) => `${e.srcId}>${e.dstId}`).sort();
    expect(keys).toEqual(["a.ts>b.ts", "b.ts>b.ts", "b.ts>npm:zod"]);
    expect(edges.find((e) => e.srcId === "a.ts")?.attrs).toEqual({ weight: 2 });
  });

  it("includes the symbol layer on request", () => {
    const { store, snapshotId } = seededStore();
    expect(store.listEdgesTouching(snapshotId, "b.ts#run")).toEqual([]);
    const withRefs = store.listEdgesTouching(snapshotId, "b.ts#run", { includeReferences: true });
    expect(withRefs).toEqual([{ srcId: "a.ts", dstId: "b.ts#run", kind: "references", attrs: {} }]);
  });
});

describe("aggregateMetrics", () => {
  it("aggregates per metric name and node kind, counting only non-null values", () => {
    const { store, snapshotId } = seededStore();
    expect(store.aggregateMetrics(snapshotId)).toEqual([
      { name: "fan_in", nodeKind: "file", count: 1, sum: 1, min: 1, max: 1 },
      { name: "loc", nodeKind: "file", count: 2, sum: 40, min: 10, max: 30 },
      { name: "utilization", nodeKind: "external", count: 0, sum: null, min: null, max: null },
      { name: "utilization", nodeKind: "symbol", count: 1, sum: 4, min: 4, max: 4 },
    ]);
  });

  it("narrows to one metric name", () => {
    const { store, snapshotId } = seededStore();
    expect(store.aggregateMetrics(snapshotId, { name: "loc" })).toEqual([
      { name: "loc", nodeKind: "file", count: 2, sum: 40, min: 10, max: 30 },
    ]);
  });
});

describe("targeted statement plans", () => {
  const params: Record<keyof TargetedStatements, unknown[]> = {
    listMetricsForNode: [1, "b.ts"],
    listEdgesTouching: [{ snapshotId: 1, nodeId: "b.ts" }],
    aggregateMetric: [1, "loc"],
    aggregateMetrics: [1],
    listMetricNames: [1],
    topByMetric: [1, "loc", 20],
    topByMetricOfKind: [1, "loc", "file", 20],
  };

  it.each(Object.entries(params))("%s searches an index and never scans a table", (name, args) => {
    const { store } = seededStore();
    const sql = prepareTargetedStatements(store.db)[name as keyof TargetedStatements].source;
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[];
    const detail = plan.map((r) => r.detail);
    expect(detail.some((d) => d.startsWith("SEARCH"))).toBe(true);
    expect(detail.filter((d) => d.startsWith("SCAN"))).toEqual([]);
  });
});
