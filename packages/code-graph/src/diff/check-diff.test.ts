import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { openCodeGraph, type CodeGraphStore } from "../store.js";
import { diffCheckResults } from "./check-diff.js";
import type { CheckRule } from "../check/types.js";

interface Fixture {
  dir: string;
  dbPath: string;
  fromId: number;
  toId: number;
}

async function createFixture(
  populateFrom: (db: CodeGraphStore, snapshotId: number) => void,
  populateTo: (db: CodeGraphStore, snapshotId: number) => void,
): Promise<Fixture> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "codewatch-check-diff-"));
  const dbPath = path.join(dir, "graph.db");
  const db = openCodeGraph(dbPath);
  const fromId = db.createSnapshot({ ref: "from", indexVersion: "0.1.0" });
  populateFrom(db, fromId);
  const toId = db.createSnapshot({ ref: "to", indexVersion: "0.1.0" });
  populateTo(db, toId);
  db.close();
  return { dir, dbPath, fromId, toId };
}

const MAX_LOC: CheckRule = {
  type: "metric-max",
  id: "max-loc",
  metric: "loc",
  max: 100,
};

describe("diffCheckResults", () => {
  let fixture: Fixture;

  afterEach(async () => {
    if (fixture) await fs.rm(fixture.dir, { recursive: true, force: true });
  });

  it("classifies a new violation that didn't exist before", async () => {
    fixture = await createFixture(
      () => {},
      (db, snapshotId) => {
        db.insertNodes(snapshotId, [{ id: "new.ts", kind: "file", name: "" }]);
        db.insertMetrics(snapshotId, [{ nodeId: "new.ts", name: "loc", value: 500 }]);
      },
    );
    const db = openCodeGraph(fixture.dbPath);
    try {
      const diff = diffCheckResults(db, {
        fromSnapshotId: fixture.fromId,
        toSnapshotId: fixture.toId,
        rules: [MAX_LOC],
      });
      expect(diff.newViolations.map((v) => v.nodeId)).toEqual(["new.ts"]);
      expect(diff.resolvedViolations).toEqual([]);
      expect(diff.unchanged).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("classifies a resolved violation that existed only in from", async () => {
    fixture = await createFixture(
      (db, snapshotId) => {
        db.insertNodes(snapshotId, [{ id: "gone.ts", kind: "file", name: "" }]);
        db.insertMetrics(snapshotId, [{ nodeId: "gone.ts", name: "loc", value: 500 }]);
      },
      () => {},
    );
    const db = openCodeGraph(fixture.dbPath);
    try {
      const diff = diffCheckResults(db, {
        fromSnapshotId: fixture.fromId,
        toSnapshotId: fixture.toId,
        rules: [MAX_LOC],
      });
      expect(diff.newViolations).toEqual([]);
      expect(diff.resolvedViolations.map((v) => v.nodeId)).toEqual(["gone.ts"]);
    } finally {
      db.close();
    }
  });

  it("reports value deltas as worsened or improved", async () => {
    fixture = await createFixture(
      (db, snapshotId) => {
        db.insertNodes(snapshotId, [
          { id: "worse.ts", kind: "file", name: "" },
          { id: "better.ts", kind: "file", name: "" },
        ]);
        db.insertMetrics(snapshotId, [
          { nodeId: "worse.ts", name: "loc", value: 200 },
          { nodeId: "better.ts", name: "loc", value: 800 },
        ]);
      },
      (db, snapshotId) => {
        db.insertNodes(snapshotId, [
          { id: "worse.ts", kind: "file", name: "" },
          { id: "better.ts", kind: "file", name: "" },
        ]);
        db.insertMetrics(snapshotId, [
          { nodeId: "worse.ts", name: "loc", value: 300 },
          { nodeId: "better.ts", name: "loc", value: 400 },
        ]);
      },
    );
    const db = openCodeGraph(fixture.dbPath);
    try {
      const diff = diffCheckResults(db, {
        fromSnapshotId: fixture.fromId,
        toSnapshotId: fixture.toId,
        rules: [MAX_LOC],
      });
      expect(diff.worsened.map((u) => u.to.nodeId)).toEqual(["worse.ts"]);
      expect(diff.improved.map((u) => u.to.nodeId)).toEqual(["better.ts"]);
      expect(diff.worsened[0]!.delta).toBe(100);
      expect(diff.improved[0]!.delta).toBe(-400);
    } finally {
      db.close();
    }
  });

  it("handles forbid-import violations (no metric value) with null delta", async () => {
    fixture = await createFixture(
      (db, snapshotId) => {
        db.insertNodes(snapshotId, [
          { id: "render/a.ts", kind: "file", name: "" },
          { id: "cli/b.ts", kind: "file", name: "" },
        ]);
        db.insertEdges(snapshotId, [{
          srcId: "render/a.ts",
          dstId: "cli/b.ts",
          kind: "imports",
        }]);
      },
      (db, snapshotId) => {
        db.insertNodes(snapshotId, [
          { id: "render/a.ts", kind: "file", name: "" },
          { id: "cli/b.ts", kind: "file", name: "" },
        ]);
        db.insertEdges(snapshotId, [{
          srcId: "render/a.ts",
          dstId: "cli/b.ts",
          kind: "imports",
        }]);
      },
    );
    const db = openCodeGraph(fixture.dbPath);
    try {
      const diff = diffCheckResults(db, {
        fromSnapshotId: fixture.fromId,
        toSnapshotId: fixture.toId,
        rules: [
          {
            type: "forbid-import",
            id: "no-r2c",
            from: "render/**",
            to: "cli/**",
          },
        ],
      });
      expect(diff.newViolations).toEqual([]);
      expect(diff.resolvedViolations).toEqual([]);
      expect(diff.unchanged).toHaveLength(1);
      expect(diff.unchanged[0]!.delta).toBeNull();
      expect(diff.worsened).toEqual([]);
      expect(diff.improved).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("returns empty diff when neither snapshot has violations", async () => {
    fixture = await createFixture(
      (db, snapshotId) => {
        db.insertNodes(snapshotId, [{ id: "fine.ts", kind: "file", name: "" }]);
        db.insertMetrics(snapshotId, [{ nodeId: "fine.ts", name: "loc", value: 1 }]);
      },
      (db, snapshotId) => {
        db.insertNodes(snapshotId, [{ id: "fine.ts", kind: "file", name: "" }]);
        db.insertMetrics(snapshotId, [{ nodeId: "fine.ts", name: "loc", value: 1 }]);
      },
    );
    const db = openCodeGraph(fixture.dbPath);
    try {
      const diff = diffCheckResults(db, {
        fromSnapshotId: fixture.fromId,
        toSnapshotId: fixture.toId,
        rules: [MAX_LOC],
      });
      expect(diff.newViolations).toEqual([]);
      expect(diff.resolvedViolations).toEqual([]);
      expect(diff.unchanged).toEqual([]);
    } finally {
      db.close();
    }
  });
});
