import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planPrune, runPrune } from "./prune.js";
import { openCodeGraph, type CodeGraphStore } from "./store.js";

interface Fixture {
  dir: string;
  dbPath: string;
}

async function createFixture(): Promise<Fixture> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "code-graph-prune-"));
  return { dir, dbPath: path.join(dir, "graph.db") };
}

async function populate(fixture: Fixture, populator: (store: CodeGraphStore) => void): Promise<void> {
  const store = openCodeGraph(fixture.dbPath);
  try {
    populator(store);
  } finally {
    store.close();
  }
}

function createN(store: CodeGraphStore, refs: readonly string[]): number[] {
  const ids: number[] = [];
  for (const ref of refs) {
    const id = store.createSnapshot({ ref, indexVersion: "0.1.0" });
    store.insertNodes(id, [{ id: `f-${id}.ts`, kind: "file", name: "f" }]);
    ids.push(id);
  }
  return ids;
}

describe("planPrune", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await createFixture();
  });
  afterEach(async () => {
    await fs.rm(fixture.dir, { recursive: true, force: true });
  });

  it("keeps the most recent N by default", async () => {
    await populate(fixture, (store) => createN(store, ["a", "b", "c", "d", "e"]));
    const store = openCodeGraph(fixture.dbPath);
    try {
      const plan = planPrune(store, { keep: 2 });
      expect(plan.keep.map((s) => s.ref)).toEqual(["e", "d"]);
      expect(plan.remove.map((s) => s.ref).sort()).toEqual(["a", "b", "c"]);
    } finally {
      store.close();
    }
  });

  it("always keeps snapshots whose ref is in keepRefs, even if older than keep limit", async () => {
    await populate(fixture, (store) => createN(store, ["main", "a", "b", "c", "d"]));
    const store = openCodeGraph(fixture.dbPath);
    try {
      const plan = planPrune(store, { keep: 2, keepRefs: ["main"] });
      const keptRefs = new Set(plan.keep.map((s) => s.ref));
      expect(keptRefs.has("main")).toBe(true);
      expect(keptRefs.has("d")).toBe(true);
      expect(keptRefs.has("c")).toBe(true);
      const removedRefs = plan.remove.map((s) => s.ref).sort();
      expect(removedRefs).toEqual(["a", "b"]);
    } finally {
      store.close();
    }
  });

  it("returns empty remove list when total snapshots <= keep", async () => {
    await populate(fixture, (store) => createN(store, ["a", "b"]));
    const store = openCodeGraph(fixture.dbPath);
    try {
      const plan = planPrune(store, { keep: 10 });
      expect(plan.remove).toEqual([]);
      expect(plan.keep).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});

describe("runPrune", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await createFixture();
  });
  afterEach(async () => {
    await fs.rm(fixture.dir, { recursive: true, force: true });
  });

  it("deletes the planned snapshots and cascades to nodes", async () => {
    await populate(fixture, (store) => createN(store, ["a", "b", "c"]));
    const store = openCodeGraph(fixture.dbPath);
    try {
      const before = store.listSnapshots({ limit: 100 }).length;
      expect(before).toBe(3);
      const result = runPrune(store, { keep: 1 });
      expect(result.plan.remove).toHaveLength(2);
      expect(store.listSnapshots({ limit: 100 })).toHaveLength(1);
      expect(result.rowsBefore.snapshot).toBe(3);
      expect(result.rowsAfter.snapshot).toBe(1);
      expect(result.rowsBefore.node).toBe(3);
      expect(result.rowsAfter.node).toBe(1);
    } finally {
      store.close();
    }
  });

  it("is a no-op when nothing is over the keep limit", async () => {
    await populate(fixture, (store) => createN(store, ["a", "b"]));
    const store = openCodeGraph(fixture.dbPath);
    try {
      const result = runPrune(store, { keep: 5 });
      expect(result.plan.remove).toEqual([]);
      expect(result.rowsBefore.snapshot).toBe(result.rowsAfter.snapshot);
    } finally {
      store.close();
    }
  });

  it("vacuums when requested", async () => {
    await populate(fixture, (store) => createN(store, ["a", "b", "c"]));
    const store = openCodeGraph(fixture.dbPath);
    try {
      const result = runPrune(store, { keep: 1, vacuum: true });
      expect(result.vacuumed).toBe(true);
    } finally {
      store.close();
    }
  });
});
