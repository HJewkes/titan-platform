import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { indexPaths } from "./indexer.js";
import { openCodeGraph, type CodeGraphStore } from "./store.js";

interface HeadView {
  snapshotId: number | null;
  nodes: number;
  edges: number;
}

function readHead(reader: CodeGraphStore): HeadView {
  const head = reader.getLatestSnapshotByRef("wd");
  if (!head) return { snapshotId: null, nodes: 0, edges: 0 };
  return {
    snapshotId: head.id,
    nodes: reader.listNodes(head.id, { includeSymbols: true }).length,
    edges: reader.listEdges(head.id, { includeReferences: true }).length,
  };
}

/** Read the head from `reader` at the moment the writer enters its node and edge inserts. */
function observeMidWrite(writer: CodeGraphStore, reader: CodeGraphStore): HeadView[] {
  const seen: HeadView[] = [];
  const insertNodes = writer.insertNodes.bind(writer);
  const insertEdges = writer.insertEdges.bind(writer);
  writer.insertNodes = (id, nodes) => {
    seen.push(readHead(reader));
    insertNodes(id, nodes);
  };
  writer.insertEdges = (id, edges) => {
    seen.push(readHead(reader));
    insertEdges(id, edges);
  };
  return seen;
}

describe("indexPaths visibility to a second connection", () => {
  let root: string;
  let writer: CodeGraphStore;
  let reader: CodeGraphStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-atomic-"));
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src/a.ts"), "export const A = 1;\n");
    await fs.writeFile(path.join(root, "src/b.ts"), 'import { A } from "./a.js";\nexport const B = A;\n');
    const dbPath = path.join(root, "graph.sqlite3");
    writer = openCodeGraph(dbPath);
    reader = openCodeGraph(dbPath);
  });

  afterEach(async () => {
    writer.close();
    reader.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("shows only the previous complete head while a new snapshot is being written", async () => {
    const first = await indexPaths(writer, { paths: [root], computeChurn: false });
    const previous = readHead(reader);
    expect(previous).toEqual({ snapshotId: first.snapshotId, nodes: first.nodes, edges: first.edges });
    const seen = observeMidWrite(writer, reader);

    const second = await indexPaths(writer, { paths: [root], computeChurn: false, incremental: false });

    expect(seen).toHaveLength(2);
    for (const view of seen) expect(view).toEqual(previous);
    expect(readHead(reader)).toEqual({ snapshotId: second.snapshotId, nodes: second.nodes, edges: second.edges });
  });

  it("shows no head at all while the first snapshot is being written", async () => {
    const seen = observeMidWrite(writer, reader);

    const first = await indexPaths(writer, { paths: [root], computeChurn: false });

    for (const view of seen) expect(view).toEqual({ snapshotId: null, nodes: 0, edges: 0 });
    expect(readHead(reader).snapshotId).toBe(first.snapshotId);
  });
}, 30_000);

/** Make the writer's edge insert throw, after the snapshot row and its nodes are already written. */
function failEdgeInsert(writer: CodeGraphStore): void {
  writer.insertEdges = () => {
    throw new Error("edge insert failed");
  };
}

describe("indexPaths when a write throws part-way", () => {
  let root: string;
  let store: CodeGraphStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-throw-"));
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src/a.ts"), "export const A = 1;\n");
    await fs.writeFile(path.join(root, "src/b.ts"), 'import { A } from "./a.js";\nexport const B = A;\n');
    store = openCodeGraph(path.join(root, "graph.sqlite3"));
  });

  afterEach(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("leaves no snapshot behind when the first index throws", async () => {
    failEdgeInsert(store);

    await expect(indexPaths(store, { paths: [root], computeChurn: false })).rejects.toThrow("edge insert failed");

    expect(store.listSnapshots()).toHaveLength(0);
    expect(store.getLatestSnapshotByRef("wd")).toBeNull();
  });

  it("keeps the previous complete head when a later index throws", async () => {
    const first = await indexPaths(store, { paths: [root], computeChurn: false });
    const before = readHead(store);
    const snapshotsBefore = store.listSnapshots().length;
    failEdgeInsert(store);

    await expect(
      indexPaths(store, { paths: [root], computeChurn: false, incremental: false }),
    ).rejects.toThrow("edge insert failed");

    expect(store.listSnapshots()).toHaveLength(snapshotsBefore);
    expect(store.getLatestSnapshotByRef("wd")?.id).toBe(first.snapshotId);
    expect(readHead(store)).toEqual(before);
  });
}, 30_000);
