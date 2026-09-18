import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { openCodeGraph, type CodeGraphStore } from "../store.js";
import { diffSnapshots } from "./diff.js";
import type { GraphEdge, GraphNode } from "../types.js";

function fileNode(id: string, name = id): GraphNode {
  return { id, kind: "file", name };
}

function importsEdge(srcId: string, dstId: string): GraphEdge {
  return { srcId, dstId, kind: "imports" };
}

describe("diffSnapshots", () => {
  let dbDir: string;
  let dbPath: string;
  let db: CodeGraphStore;

  beforeEach(async () => {
    dbDir = path.join(tmpdir(), `codewatch-diff-${Date.now()}-${Math.random()}`);
    await fs.mkdir(dbDir, { recursive: true });
    dbPath = path.join(dbDir, "graph.db");
    db = openCodeGraph(dbPath);
  });

  afterEach(async () => {
    db.close();
    await fs.rm(dbDir, { recursive: true, force: true });
  });

  it("reports unchanged nodes when both snapshots match exactly", () => {
    const a = db.createSnapshot({ ref: "main", indexVersion: "0.1.0" });
    const b = db.createSnapshot({ ref: "feat", indexVersion: "0.1.0" });
    const nodes = [fileNode("a.ts"), fileNode("b.ts")];
    db.insertNodes(a, nodes);
    db.insertNodes(b, nodes);

    const result = diffSnapshots(db, { fromSnapshotId: a, toSnapshotId: b });

    expect(result.summary.addedNodes).toBe(0);
    expect(result.summary.removedNodes).toBe(0);
    expect(result.summary.unchangedNodes).toBe(2);
    expect(result.addedNodes).toEqual([]);
    expect(result.removedNodes).toEqual([]);
  });

  it("detects added and removed nodes", () => {
    const a = db.createSnapshot({ ref: "main", indexVersion: "0.1.0" });
    const b = db.createSnapshot({ ref: "feat", indexVersion: "0.1.0" });
    db.insertNodes(a, [fileNode("a.ts"), fileNode("removed.ts")]);
    db.insertNodes(b, [fileNode("a.ts"), fileNode("new.ts")]);

    const result = diffSnapshots(db, { fromSnapshotId: a, toSnapshotId: b });

    expect(result.addedNodes.map((n) => n.id)).toEqual(["new.ts"]);
    expect(result.removedNodes.map((n) => n.id)).toEqual(["removed.ts"]);
    expect(result.summary.unchangedNodes).toBe(1);
  });

  it("detects added and removed edges", () => {
    const a = db.createSnapshot({ ref: "main", indexVersion: "0.1.0" });
    const b = db.createSnapshot({ ref: "feat", indexVersion: "0.1.0" });
    db.insertNodes(a, [fileNode("a.ts"), fileNode("b.ts"), fileNode("c.ts")]);
    db.insertNodes(b, [fileNode("a.ts"), fileNode("b.ts"), fileNode("c.ts")]);
    db.insertEdges(a, [importsEdge("a.ts", "b.ts")]);
    db.insertEdges(b, [importsEdge("a.ts", "c.ts")]);

    const result = diffSnapshots(db, { fromSnapshotId: a, toSnapshotId: b });

    expect(result.addedEdges).toEqual([
      { srcId: "a.ts", dstId: "c.ts", kind: "imports", attrs: {} },
    ]);
    expect(result.removedEdges).toEqual([
      { srcId: "a.ts", dstId: "b.ts", kind: "imports", attrs: {} },
    ]);
  });

  it("treats aliased nodes as renames, not delete+add", () => {
    const a = db.createSnapshot({ ref: "main", indexVersion: "0.1.0" });
    const b = db.createSnapshot({ ref: "feat", indexVersion: "0.1.0" });
    db.insertNodes(a, [fileNode("old/path.ts")]);
    db.insertNodes(b, [fileNode("new/path.ts")]);
    db.insertAliases(b, [
      { oldId: "old/path.ts", newId: "new/path.ts", reason: "move" },
    ]);

    const result = diffSnapshots(db, { fromSnapshotId: a, toSnapshotId: b });

    expect(result.summary.addedNodes).toBe(0);
    expect(result.summary.removedNodes).toBe(0);
    expect(result.summary.renamedNodes).toBe(1);
    expect(result.renamedNodes[0]).toMatchObject({
      oldId: "old/path.ts",
      newId: "new/path.ts",
      reason: "move",
    });
  });

  it("substitutes aliases when comparing edges so renames don't churn", () => {
    const a = db.createSnapshot({ ref: "main", indexVersion: "0.1.0" });
    const b = db.createSnapshot({ ref: "feat", indexVersion: "0.1.0" });
    db.insertNodes(a, [fileNode("old.ts"), fileNode("dep.ts")]);
    db.insertNodes(b, [fileNode("new.ts"), fileNode("dep.ts")]);
    db.insertEdges(a, [importsEdge("old.ts", "dep.ts")]);
    db.insertEdges(b, [importsEdge("new.ts", "dep.ts")]);
    db.insertAliases(b, [
      { oldId: "old.ts", newId: "new.ts", reason: "rename" },
    ]);

    const result = diffSnapshots(db, { fromSnapshotId: a, toSnapshotId: b });

    expect(result.addedEdges).toEqual([]);
    expect(result.removedEdges).toEqual([]);
  });

  it("reports metric deltas for nodes present in both snapshots", () => {
    const a = db.createSnapshot({ ref: "main", indexVersion: "0.1.0" });
    const b = db.createSnapshot({ ref: "feat", indexVersion: "0.1.0" });
    db.insertNodes(a, [fileNode("a.ts")]);
    db.insertNodes(b, [fileNode("a.ts")]);
    db.insertMetrics(a, [{ nodeId: "a.ts", name: "loc", value: 100 }]);
    db.insertMetrics(b, [{ nodeId: "a.ts", name: "loc", value: 142 }]);

    const result = diffSnapshots(db, { fromSnapshotId: a, toSnapshotId: b });

    expect(result.metricDeltas).toEqual([
      { nodeId: "a.ts", name: "loc", before: 100, after: 142, delta: 42 },
    ]);
    expect(result.summary.metricChanges).toBe(1);
  });

  it("includes newly-added metrics on common nodes", () => {
    const a = db.createSnapshot({ ref: "main", indexVersion: "0.1.0" });
    const b = db.createSnapshot({ ref: "feat", indexVersion: "0.1.0" });
    db.insertNodes(a, [fileNode("a.ts")]);
    db.insertNodes(b, [fileNode("a.ts")]);
    db.insertMetrics(b, [{ nodeId: "a.ts", name: "fan_in", value: 3 }]);

    const result = diffSnapshots(db, { fromSnapshotId: a, toSnapshotId: b });

    expect(result.metricDeltas).toEqual([
      { nodeId: "a.ts", name: "fan_in", before: null, after: 3, delta: null },
    ]);
  });

  it("ignores metric deltas on nodes that were added or removed", () => {
    const a = db.createSnapshot({ ref: "main", indexVersion: "0.1.0" });
    const b = db.createSnapshot({ ref: "feat", indexVersion: "0.1.0" });
    db.insertNodes(a, [fileNode("removed.ts")]);
    db.insertNodes(b, [fileNode("added.ts")]);
    db.insertMetrics(a, [{ nodeId: "removed.ts", name: "loc", value: 10 }]);
    db.insertMetrics(b, [{ nodeId: "added.ts", name: "loc", value: 20 }]);

    const result = diffSnapshots(db, { fromSnapshotId: a, toSnapshotId: b });

    expect(result.metricDeltas).toEqual([]);
  });

  it("reconciles a deprecated metric name across snapshots", () => {
    const a = db.createSnapshot({ ref: "old", indexVersion: "0.1.0" });
    const b = db.createSnapshot({ ref: "new", indexVersion: "0.2.0" });
    db.insertNodes(a, [fileNode("a.ts")]);
    db.insertNodes(b, [fileNode("a.ts")]);
    // Same metric, spelled with a deprecated alias in the old snapshot.
    db.insertMetrics(a, [{ nodeId: "a.ts", name: "fan-in", value: 3 }]);
    db.insertMetrics(b, [{ nodeId: "a.ts", name: "fan_in", value: 5 }]);

    const result = diffSnapshots(db, { fromSnapshotId: a, toSnapshotId: b });

    // Lines up as a single canonical delta, not a removed+added pair.
    expect(result.metricDeltas).toEqual([
      { nodeId: "a.ts", name: "fan_in", before: 3, after: 5, delta: 2 },
    ]);
  });

  it("does not report drift when only the metric spelling changed", () => {
    const a = db.createSnapshot({ ref: "old", indexVersion: "0.1.0" });
    const b = db.createSnapshot({ ref: "new", indexVersion: "0.2.0" });
    db.insertNodes(a, [fileNode("a.ts")]);
    db.insertNodes(b, [fileNode("a.ts")]);
    db.insertMetrics(a, [{ nodeId: "a.ts", name: "lines", value: 100 }]);
    db.insertMetrics(b, [{ nodeId: "a.ts", name: "loc", value: 100 }]);

    const result = diffSnapshots(db, { fromSnapshotId: a, toSnapshotId: b });

    expect(result.metricDeltas).toEqual([]);
  });

});
