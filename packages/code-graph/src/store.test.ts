import { describe, expect, it } from "vitest";
import { openCodeGraph } from "./store.js";

const openTemp = () => openCodeGraph(":memory:");

describe("CodeGraphStore", () => {
  it("round-trips a snapshot with its provenance", () => {
    const store = openTemp();
    const id = store.createSnapshot({ ref: "head", commitHash: "abc123", indexVersion: "1.0.0" });
    expect(store.getSnapshot(id)).toMatchObject({
      ref: "head",
      commitHash: "abc123",
      indexVersion: "1.0.0",
    });
    expect(store.getLatestSnapshotByRef("head")?.id).toBe(id);
    expect(store.getLatestSnapshotByRef("other")).toBeNull();
  });

  it("round-trips nodes with the language and role columns the kit shape lacks", () => {
    const store = openTemp();
    const id = store.createSnapshot({ ref: "head", indexVersion: "1.0.0" });
    store.insertNodes(id, [
      { id: "src/a.ts", kind: "file", name: "a.ts", parentId: "src/a", language: "typescript", role: "source" },
      { id: "src/a.ts#run", kind: "symbol", name: "run", parentId: "src/a.ts", attrs: { exported: true } },
    ]);
    expect(store.getNode(id, "src/a.ts")).toMatchObject({ language: "typescript", role: "source" });
    expect(store.getNode(id, "src/a.ts#run")?.attrs).toEqual({ exported: true });
  });

  it("hides the symbol layer from listNodes and listEdges unless asked", () => {
    const store = openTemp();
    const id = store.createSnapshot({ ref: "head", indexVersion: "1.0.0" });
    store.insertNodes(id, [
      { id: "src/a.ts", kind: "file", name: "a.ts" },
      { id: "src/a.ts#run", kind: "symbol", name: "run" },
    ]);
    store.insertEdges(id, [
      { srcId: "src/b.ts", dstId: "src/a.ts", kind: "imports" },
      { srcId: "src/b.ts", dstId: "src/a.ts#run", kind: "references" },
    ]);
    expect(store.listNodes(id).map((n) => n.id)).toEqual(["src/a.ts"]);
    expect(store.listNodes(id, { includeSymbols: true })).toHaveLength(2);
    expect(store.listEdges(id).map((e) => e.kind)).toEqual(["imports"]);
    expect(store.listEdges(id, { includeReferences: true })).toHaveLength(2);
  });

  it("round-trips metrics, aliases, and fingerprints", () => {
    const store = openTemp();
    const id = store.createSnapshot({ ref: "head", indexVersion: "1.0.0" });
    store.insertMetrics(id, [{ nodeId: "src/a.ts", name: "loc", value: 12, unit: "count" }]);
    store.insertAliases(id, [{ oldId: "src/old.ts", newId: "src/a.ts", reason: "rename" }]);
    store.insertFingerprints(id, [{ fileId: "src/a.ts", contentHash: "h1", structuralHash: "s1" }]);
    expect(store.listMetrics(id)).toEqual([{ nodeId: "src/a.ts", name: "loc", value: 12, unit: "count" }]);
    expect(store.listAliases(id)).toEqual([{ oldId: "src/old.ts", newId: "src/a.ts", reason: "rename" }]);
    expect(store.listFingerprints(id)).toEqual([
      { fileId: "src/a.ts", contentHash: "h1", structuralHash: "s1" },
    ]);
  });

  it("keeps snapshots isolated from one another", () => {
    const store = openTemp();
    const first = store.createSnapshot({ ref: "head", indexVersion: "1.0.0" });
    const second = store.createSnapshot({ ref: "head", indexVersion: "1.0.0" });
    store.insertNodes(first, [{ id: "src/a.ts", kind: "file", name: "a.ts" }]);
    expect(store.listNodes(second)).toEqual([]);
    expect(store.listSnapshots()).toHaveLength(2);
  });
});
