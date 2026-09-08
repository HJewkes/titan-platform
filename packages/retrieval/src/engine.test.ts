import { HashEmbedder } from "@titan-design/embed";
import { EdgeTable, SpanFtsTables, edgeTableDdl, openDatabase, spanFtsTablesDdl } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { createRetrievalEngine } from "./engine.js";
import { crossEncoderReranker } from "./rerank.js";
import { defaultMatchExpression, ftsRetriever } from "./retrievers/fts.js";
import { expandGraph, graphRetriever } from "./retrievers/graph.js";
import { BruteForceVectorIndex, vectorRetriever } from "./retrievers/vector.js";

const docs: Record<string, string> = {
  "note:vitest": "the vitest suite in packages/registry keeps failing on CI",
  "note:deploy": "deploy the cloudflare worker with wrangler and check the logs",
  "note:daemon": "the daemon watches the state directory and streams SSE events",
  "note:flaky": "flaky vitest run, retry the failing test once",
};

async function corpus() {
  const db = openDatabase(":memory:");
  db.exec(spanFtsTablesDdl() + edgeTableDdl());
  const spans = new SpanFtsTables(db);
  const edges = new EdgeTable(db);
  const embedder = new HashEmbedder();
  const index = new BruteForceVectorIndex();
  let offset = 0;
  for (const [id, text] of Object.entries(docs)) {
    spans.index({ ownerRef: id, field: "body", sourceId: 1, byteOffset: offset, byteLength: text.length }, text);
    offset += text.length + 1;
    const [v] = await embedder.embed([text]);
    index.add(id, v!);
  }
  edges.assert({ sourceRef: "note:vitest", relation: "related", targetRef: "note:flaky" });
  edges.assert({ sourceRef: "task:TP-2", relation: "advances", targetRef: "note:vitest" });
  return { spans, edges, embedder, index };
}

describe("retrievers over real store tables", () => {
  it("fts collapses spans per owner and carries the locator", async () => {
    const { spans } = await corpus();
    const hits = await ftsRetriever(spans).retrieve("vitest failing", { limit: 10 });
    expect(hits.map((h) => h.id).sort()).toEqual(["note:flaky", "note:vitest"]);
    expect(hits[0]!.payload).toMatchObject({ field: "body", sourceId: 1 });
    expect(defaultMatchExpression("fix: the (broken) build!")).toBe('"fix" OR "the" OR "broken" OR "build"');
    expect(await ftsRetriever(spans).retrieve("!!!", { limit: 10 })).toEqual([]);
  });

  it("vector ranks by cosine similarity and honors a similarity floor", async () => {
    const { embedder, index } = await corpus();
    const hits = await vectorRetriever(embedder, index).retrieve("vitest suite failing in packages/registry", { limit: 2 });
    expect(hits[0]!.id).toBe("note:vitest");
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score!);
    const strict = await vectorRetriever(embedder, index, { minSimilarity: 0.99 }).retrieve("unrelated words entirely", { limit: 5 });
    expect(strict).toEqual([]);
  });

  it("graph expands seeds through edges in both directions, by hop", async () => {
    const { edges } = await corpus();
    const hits = expandGraph(edges, ["note:vitest"], { hops: 2 });
    expect(hits.map((h) => [h.id, h.payload?.hop])).toEqual([
      ["note:flaky", 1],
      ["task:TP-2", 1],
    ]);
    expect(expandGraph(edges, ["note:vitest"], { direction: "out" }).map((h) => h.id)).toEqual(["note:flaky"]);
    expect(expandGraph(edges, ["note:vitest"], { relations: ["advances"] }).map((h) => h.id)).toEqual(["task:TP-2"]);
  });
});

describe("createRetrievalEngine", () => {
  it("fuses fts, vector, and graph and reports no degradation when all succeed", async () => {
    const { spans, edges, embedder, index } = await corpus();
    const fts = ftsRetriever(spans);
    const engine = createRetrievalEngine({
      retrievers: [fts, vectorRetriever(embedder, index), graphRetriever(edges, fts, { seedLimit: 1 })],
    });
    const { results, degraded, timingsMs } = await engine.search("vitest failing", { limit: 3 });
    expect(degraded).toEqual([]);
    expect(Object.keys(timingsMs).sort()).toEqual(["fts", "graph", "vector"]);
    expect(results[0]!.id).toBe("note:vitest");
    expect(results[0]!.sources).toContain("fts");
    expect(results[0]!.sources).toContain("vector");
    expect(results.map((r) => r.id)).toContain("note:flaky");
  });

  it("fails open when the vector retriever's embedder is down", async () => {
    const { spans, index } = await corpus();
    const down = { model: "dead", dimensions: 1, embed: async () => Promise.reject(new Error("ECONNREFUSED")) };
    const engine = createRetrievalEngine({ retrievers: [ftsRetriever(spans), vectorRetriever(down, index)] });
    const { results, degraded } = await engine.search("daemon events");
    expect(results.map((r) => r.id)).toEqual(["note:daemon"]);
    expect(degraded).toEqual([{ retriever: "vector", reason: "error", message: "ECONNREFUSED" }]);
  });

  it("applies the reranker to the fused top results and can be skipped per query", async () => {
    const { spans } = await corpus();
    const classifier = vi.fn(async (pairs: [string, string][]) => pairs.map(([, text]) => ({ label: "x", score: text.includes("flaky") ? 0.9 : 0.1 })));
    const reranker = crossEncoderReranker({ loadClassifier: async () => classifier });
    const engine = createRetrievalEngine({ retrievers: [ftsRetriever(spans)], reranker, textFor: (r) => docs[r.id]! });
    const reranked = await engine.search("vitest failing");
    expect(reranked.results[0]).toMatchObject({ id: "note:flaky", score: 0.9 });
    const plain = await engine.search("vitest failing", { rerank: false });
    expect(plain.results.map((r) => r.id).sort()).toEqual(["note:flaky", "note:vitest"]);
    expect(plain.results[0]!.score).toBeLessThan(0.5);
    expect(classifier).toHaveBeenCalledTimes(1);
  });

  it("returns nothing for a blank query and requires textFor with a reranker", async () => {
    const { spans } = await corpus();
    const engine = createRetrievalEngine({ retrievers: [ftsRetriever(spans)] });
    expect(await engine.search("   ")).toEqual({ results: [], degraded: [], timingsMs: {} });
    expect(() => createRetrievalEngine({ retrievers: [], reranker: crossEncoderReranker() })).toThrow(/textFor is required/);
  });
});
