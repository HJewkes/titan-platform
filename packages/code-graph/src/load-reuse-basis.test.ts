import { describe, expect, it } from "vitest";
import { loadReuseBasis } from "./incremental.js";
import type { CodeGraphStore } from "./store.js";
import type {
  FileFingerprint,
  GraphEdge,
  GraphMetric,
  GraphNode,
  SnapshotRow,
} from "./types.js";

interface Fixture {
  snapshots: SnapshotRow[];
  fingerprints?: Record<number, FileFingerprint[]>;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  metrics?: GraphMetric[];
}

function snapshot(id: number, indexVersion: string): SnapshotRow {
  return { id, ref: "wd", commitHash: null, takenAt: "t", indexVersion, attrs: {} };
}

function stubStore(fx: Fixture, calls: string[] = []): CodeGraphStore {
  return {
    listSnapshots: () => fx.snapshots,
    listFingerprints: (id: number) => {
      calls.push(`fingerprints:${id}`);
      return fx.fingerprints?.[id] ?? [];
    },
    listNodes: (id: number, opts: unknown) => {
      calls.push(`nodes:${id}:${JSON.stringify(opts)}`);
      return fx.nodes ?? [];
    },
    listEdges: (id: number, opts: unknown) => {
      calls.push(`edges:${id}:${JSON.stringify(opts)}`);
      return fx.edges ?? [];
    },
    listMetrics: (id: number) => {
      calls.push(`metrics:${id}`);
      return fx.metrics ?? [];
    },
  } as unknown as CodeGraphStore;
}

const FILE_A: GraphNode = { id: "a.ts", kind: "file", name: "a.ts" };
const SYM_A: GraphNode = { id: "a.ts#run", kind: "symbol", name: "run", parentId: "a.ts" };
const SYM_A2: GraphNode = { id: "a.ts#stop", kind: "symbol", name: "stop", parentId: "a.ts" };

describe("loadReuseBasis", () => {
  it("returns null when no snapshot matches the index version", () => {
    const store = stubStore({
      snapshots: [snapshot(2, "old")],
      fingerprints: { 2: [{ fileId: "a.ts", contentHash: "h" }] },
    });
    expect(loadReuseBasis(store, "new")).toBeNull();
  });

  it("skips a matching snapshot with no fingerprints and uses the next one", () => {
    const calls: string[] = [];
    const store = stubStore(
      {
        snapshots: [snapshot(3, "v"), snapshot(2, "v")],
        fingerprints: { 2: [{ fileId: "a.ts", contentHash: "h" }] },
      },
      calls,
    );
    expect(loadReuseBasis(store, "v")?.snapshotId).toBe(2);
    expect(calls).toEqual([
      "fingerprints:3",
      "fingerprints:2",
      'nodes:2:{"includeSymbols":true}',
      'edges:2:{"includeReferences":true}',
      "metrics:2",
    ]);
  });

  it("indexes fingerprints and keeps structural hashes only where present", () => {
    const store = stubStore({
      snapshots: [snapshot(1, "v")],
      fingerprints: {
        1: [
          { fileId: "a.ts", contentHash: "h1", structuralHash: "s1" },
          { fileId: "b.ts", contentHash: "h2" },
        ],
      },
    });
    const basis = loadReuseBasis(store, "v");
    expect([...(basis?.fingerprints ?? [])]).toEqual([
      ["a.ts", "h1"],
      ["b.ts", "h2"],
    ]);
    expect([...(basis?.structuralHashes ?? [])]).toEqual([["a.ts", "s1"]]);
  });

  it("buckets nodes by id and symbols under their declaring file", () => {
    const orphan: GraphNode = { id: "x#y", kind: "symbol", name: "y" };
    const store = stubStore({
      snapshots: [snapshot(1, "v")],
      fingerprints: { 1: [{ fileId: "a.ts", contentHash: "h" }] },
      nodes: [FILE_A, SYM_A, SYM_A2, orphan],
    });
    const basis = loadReuseBasis(store, "v");
    expect([...(basis?.nodesById.keys() ?? [])]).toEqual(["a.ts", "a.ts#run", "a.ts#stop", "x#y"]);
    expect([...(basis?.symbolsByFile ?? [])]).toEqual([["a.ts", [SYM_A, SYM_A2]]]);
  });

  it("files a symbol's outbound edge under its declaring file", () => {
    const fromFile: GraphEdge = { srcId: "a.ts", dstId: "b.ts", kind: "imports" };
    const fromSymbol: GraphEdge = { srcId: "a.ts#run", dstId: "b.ts#go", kind: "calls" };
    const store = stubStore({
      snapshots: [snapshot(1, "v")],
      fingerprints: { 1: [{ fileId: "a.ts", contentHash: "h" }] },
      edges: [fromFile, fromSymbol],
    });
    const basis = loadReuseBasis(store, "v");
    expect([...(basis?.edgesBySrc ?? [])]).toEqual([["a.ts", [fromFile, fromSymbol]]]);
  });

  it("carries only source, dead-code and growth-risk metrics, bucketing symbol metrics under the parent file", () => {
    const fileLoc: GraphMetric = { nodeId: "a.ts", name: "loc", value: 10 };
    const symbolCognitive: GraphMetric = { nodeId: "a.ts#run", name: "cognitive_max", value: 3 };
    const unrelated: GraphMetric = { nodeId: "a.ts", name: "not_a_carried_metric", value: 1 };
    const unknownNode: GraphMetric = { nodeId: "z.ts", name: "loc", value: 2 };
    const store = stubStore({
      snapshots: [snapshot(1, "v")],
      fingerprints: { 1: [{ fileId: "a.ts", contentHash: "h" }] },
      nodes: [FILE_A, SYM_A],
      metrics: [fileLoc, symbolCognitive, unrelated, unknownNode],
    });
    const basis = loadReuseBasis(store, "v");
    expect([...(basis?.sourceMetricsByFile ?? [])]).toEqual([
      ["a.ts", [fileLoc, symbolCognitive]],
      ["z.ts", [unknownNode]],
    ]);
  });
});
