import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCodeGraph, type CodeGraphStore } from "../store.js";
import type { GraphEdge, GraphNode, IdAlias } from "../types.js";
import { diffFootprints } from "./footprint-diff.js";

const PARSE = "src/parse.ts#parse";
const FORMAT = "src/parse.ts#format";
const RENDER = "src/render.ts#render";

function fileNode(id: string): GraphNode {
  return { id, kind: "file", name: id };
}

function symbol(id: string, attrs: Record<string, unknown> = {}): GraphNode {
  const [parentId, name] = id.split("#") as [string, string];
  return { id, kind: "symbol", name, parentId, attrs: { exported: true, signature: `function ${name}(): void`, ...attrs } };
}

function ref(srcId: string, dstId: string): GraphEdge {
  return { srcId, dstId, kind: "references" };
}

function baseNodes(): GraphNode[] {
  return [fileNode("src/parse.ts"), fileNode("src/render.ts"), symbol(PARSE), symbol(FORMAT), symbol(RENDER)];
}

function baseEdges(): GraphEdge[] {
  return [
    ref("src/a.ts", PARSE),
    ref("src/a.ts", FORMAT),
    ref("src/b.ts", PARSE),
    ref("src/b.ts", FORMAT),
    ref("src/render.ts", PARSE),
    ref("src/c.ts", RENDER),
  ];
}

describe("diffFootprints", () => {
  let dbDir: string;
  let store: CodeGraphStore;

  beforeEach(async () => {
    dbDir = path.join(tmpdir(), `code-graph-footprint-diff-${Date.now()}-${Math.random()}`);
    await fs.mkdir(dbDir, { recursive: true });
    store = openCodeGraph(path.join(dbDir, "graph.db"));
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dbDir, { recursive: true, force: true });
  });

  function snapshot(nodes: GraphNode[], edges: GraphEdge[], aliases: IdAlias[] = []): number {
    const id = store.createSnapshot({ ref: "main", indexVersion: "0.1.0" });
    store.insertNodes(id, nodes);
    store.insertEdges(id, edges);
    if (aliases.length > 0) store.insertAliases(id, aliases);
    return id;
  }

  function diff(from: number, to: number) {
    return diffFootprints(store, { fromSnapshotId: from, toSnapshotId: to });
  }

  it("reports nothing for two identical snapshots", () => {
    const from = snapshot(baseNodes(), baseEdges());
    const to = snapshot(baseNodes(), baseEdges());

    const result = diff(from, to);

    expect(result.changes).toEqual([]);
    expect(result.files).toEqual([]);
  });

  it("reports exactly renamed when a file moves with its footprint intact", () => {
    const moved = (id: string) => id.replace("src/parse.ts", "src/parsing.ts");
    const from = snapshot(baseNodes(), baseEdges());
    const to = snapshot(
      baseNodes().map((n) => ({ ...n, id: moved(n.id), ...(n.parentId ? { parentId: moved(n.parentId) } : {}) })),
      baseEdges().map((e) => ({ ...e, dstId: moved(e.dstId) })),
      [{ oldId: "src/parse.ts", newId: "src/parsing.ts", reason: "move" }],
    );

    const result = diff(from, to);

    expect(result.changes).toEqual([
      { symbolId: "src/parsing.ts#format", previousId: FORMAT, status: "changed", reasons: ["renamed"], fileId: "src/parsing.ts" },
      { symbolId: "src/parsing.ts#parse", previousId: PARSE, status: "changed", reasons: ["renamed"], fileId: "src/parsing.ts" },
    ]);
  });

  it("follows a symbol-level alias as a rename", () => {
    const requalified = "src/render.ts#Renderer.render";
    const from = snapshot(baseNodes(), baseEdges());
    const toNodes = [...baseNodes().filter((n) => n.id !== RENDER), { ...symbol(RENDER), id: requalified }];
    const toEdges = baseEdges().map((e) => (e.dstId === RENDER ? { ...e, dstId: requalified } : e));
    const to = snapshot(toNodes, toEdges, [{ oldId: RENDER, newId: requalified, reason: "requalify" }]);

    const result = diff(from, to);

    expect(result.changes).toEqual([
      { symbolId: requalified, previousId: RENDER, status: "changed", reasons: ["renamed"], fileId: "src/render.ts" },
    ]);
  });

  it("reports an added and a removed symbol", () => {
    const from = snapshot(baseNodes(), baseEdges());
    const toNodes = [...baseNodes().filter((n) => n.id !== RENDER), symbol("src/render.ts#paint")];
    const to = snapshot(toNodes, baseEdges().filter((e) => e.dstId !== RENDER));

    const result = diff(from, to);

    expect(result.changes).toEqual([
      { symbolId: "src/render.ts#paint", status: "added", reasons: [], fileId: "src/render.ts" },
      { symbolId: RENDER, status: "removed", reasons: [], fileId: "src/render.ts" },
    ]);
  });

  it("reports only signature for a signature-only edit", () => {
    const from = snapshot(baseNodes(), baseEdges());
    const edited = baseNodes().map((n) => (n.id === RENDER ? symbol(RENDER, { signature: "function render(x: number): void" }) : n));
    const to = snapshot(edited, baseEdges());

    const result = diff(from, to);

    expect(result.changes).toEqual([
      { symbolId: RENDER, status: "changed", reasons: ["signature"], fileId: "src/render.ts" },
    ]);
  });

  it("rolls changes up to declaring files only, never to consumer files", () => {
    const from = snapshot(baseNodes(), baseEdges());
    const to = snapshot(baseNodes(), [...baseEdges(), ref("src/d.ts", PARSE)]);

    const result = diff(from, to);

    expect(result.changes.map((c) => [c.symbolId, c.reasons])).toEqual([[PARSE, ["consumers"]]]);
    expect(result.files).toEqual(["src/parse.ts"]);
  });

  it("reports coupling alone when a co-import partner appears but consumers stay the same", () => {
    const from = snapshot(baseNodes(), baseEdges());
    const to = snapshot(baseNodes(), [...baseEdges(), ref("src/a.ts", RENDER), ref("src/b.ts", RENDER)]);

    const result = diff(from, to);

    expect(result.changes).toEqual([
      { symbolId: FORMAT, status: "changed", reasons: ["coupling"], fileId: "src/parse.ts" },
      { symbolId: PARSE, status: "changed", reasons: ["coupling"], fileId: "src/parse.ts" },
      { symbolId: RENDER, status: "changed", reasons: ["consumers", "coupling"], fileId: "src/render.ts" },
    ]);
  });

  it("reports the losing same-named symbol as removed when two files merge into one", () => {
    const from = snapshot([fileNode("src/a.ts"), fileNode("src/b.ts"), symbol("src/a.ts#run"), symbol("src/b.ts#run")], []);
    const to = snapshot([fileNode("src/c.ts"), symbol("src/c.ts#run")], [], [
      { oldId: "src/a.ts", newId: "src/c.ts", reason: "merge" },
      { oldId: "src/b.ts", newId: "src/c.ts", reason: "merge" },
    ]);

    const result = diff(from, to);

    expect(result.changes).toEqual([
      { symbolId: "src/b.ts#run", status: "removed", reasons: [], fileId: "src/c.ts" },
      { symbolId: "src/c.ts#run", previousId: "src/a.ts#run", status: "changed", reasons: ["renamed"], fileId: "src/c.ts" },
    ]);
  });
});
