import { HashEmbedder } from "@titan-design/embed";
import { EdgeTable, SpanFtsTables, edgeTableDdl, openDatabase, spanFtsTablesDdl } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { TIERS_STAGE, type TierSource } from "./context/request.js";
import { RERANK_STAGE, createRetrievalEngine } from "./engine.js";
import { crossEncoderReranker, type Reranker } from "./rerank.js";
import { defaultMatchExpression, ftsRetriever } from "./retrievers/fts.js";
import { expandGraph, graphRetriever } from "./retrievers/graph.js";
import { BruteForceVectorIndex, vectorRetriever } from "./retrievers/vector.js";
import type { FusedResult } from "./types.js";

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

  it("one scoped retriever per class keeps the large class from swamping the small one", async () => {
    // The situation this exists for: one class outnumbers another by enough that
    // a pooled query returns nothing else. Measured on active-work's graph,
    // 92,713 transcript spans against 1,569 note spans.
    const { spans } = await corpus();
    for (let i = 0; i < 30; i++) {
      spans.index({ ownerRef: `session:s${i}`, field: "tool_result", sourceId: 2, byteOffset: i * 40, byteLength: 40 }, "vitest vitest vitest failing failing");
    }

    const pooled = await ftsRetriever(spans).retrieve("vitest failing", { limit: 5 });
    expect(pooled.every((h) => h.id.startsWith("session:"))).toBe(true);

    const notes = ftsRetriever(spans, { name: "notes", scope: { ownerPrefix: "note:" } });
    const transcripts = ftsRetriever(spans, { name: "transcripts", scope: { ownerPrefix: "session:", fields: ["tool_result"] } });
    const engine = createRetrievalEngine({
      retrievers: [notes, transcripts],
      fusion: { weights: { notes: 3, transcripts: 1 } },
    });

    const { results } = await engine.search("vitest failing", { limit: 5 });
    // Both notes outrank every transcript, and the transcripts still appear:
    // a class prior, not a filter. Which note leads is BM25's business.
    const classOf = (id: string) => id.split(":")[0];
    expect(results.slice(0, 2).map((r) => classOf(r.id))).toEqual(["note", "note"]);
    expect(results.slice(2).every((r) => classOf(r.id) === "session")).toBe(true);
    expect(results.some((r) => classOf(r.id) === "session")).toBe(true);
  });

  it("a cap bounds a class's candidates regardless of what the engine overfetches", async () => {
    const { spans } = await corpus();
    for (let i = 0; i < 30; i++) {
      spans.index({ ownerRef: `session:s${i}`, field: "tool_result", sourceId: 2, byteOffset: i * 40, byteLength: 40 }, "vitest failing");
    }
    const capped = ftsRetriever(spans, { scope: { ownerPrefix: "session:" }, cap: 3 });

    expect(await capped.retrieve("vitest failing", { limit: 30 })).toHaveLength(3);
    // A cap is a ceiling, not a floor: a smaller engine limit still wins.
    expect(await capped.retrieve("vitest failing", { limit: 2 })).toHaveLength(2);
    expect(await ftsRetriever(spans, { cap: 0 }).retrieve("vitest", { limit: 10 })).toEqual([]);
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

  it("falls back to the fused ranking when the reranker throws, and says so in degraded", async () => {
    const { spans } = await corpus();
    const engine = (reranker: Reranker) =>
      createRetrievalEngine({ retrievers: [ftsRetriever(spans)], reranker, textFor: (r) => docs[r.id]! });
    const working = crossEncoderReranker({
      loadClassifier: async () => async (pairs) => pairs.map(([, text]) => ({ label: "x", score: text.includes("flaky") ? 0.9 : 0.1 })),
    });
    const fused = await engine(working).search("vitest failing", { rerank: false });

    const broken: Reranker = { model: "broken", score: () => Promise.reject(new Error("cross-encoder OOM")) };
    const { results, degraded } = await engine(broken).search("vitest failing");

    expect(results.map((r) => r.id)).toEqual(fused.results.map((r) => r.id));
    expect(results.map((r) => r.score)).toEqual(fused.results.map((r) => r.score));
    expect(degraded).toEqual([{ retriever: RERANK_STAGE, reason: "error", message: "cross-encoder OOM" }]);
  });

  it("keeps a retriever's degradation alongside the rerank one", async () => {
    const { spans, index } = await corpus();
    const down = { model: "dead", dimensions: 1, embed: async () => Promise.reject(new Error("ECONNREFUSED")) };
    const broken: Reranker = { model: "broken", score: () => Promise.reject(new Error("no model")) };
    const engine = createRetrievalEngine({
      retrievers: [ftsRetriever(spans), vectorRetriever(down, index)],
      reranker: broken,
      textFor: (r) => docs[r.id]!,
    });

    const { results, degraded } = await engine.search("vitest failing");

    expect(results.length).toBeGreaterThan(0);
    expect(degraded.map((d) => d.retriever)).toEqual(["vector", RERANK_STAGE]);
  });

  it("degrades when textFor throws, not only the reranker itself", async () => {
    const { spans } = await corpus();
    const reranker: Reranker = { model: "never-called", score: () => Promise.resolve([1, 0]) };
    const engine = createRetrievalEngine({
      retrievers: [ftsRetriever(spans)],
      reranker,
      textFor: () => {
        throw new Error("span body unreadable");
      },
    });

    const { results, degraded } = await engine.search("vitest failing");

    expect(results.length).toBeGreaterThan(0);
    expect(degraded).toEqual([{ retriever: RERANK_STAGE, reason: "error", message: "span body unreadable" }]);
  });

  it("returns nothing for a blank query and requires textFor with a reranker", async () => {
    const { spans } = await corpus();
    const engine = createRetrievalEngine({ retrievers: [ftsRetriever(spans)] });
    expect(await engine.search("   ")).toEqual({ results: [], degraded: [], timingsMs: {} });
    expect(() => createRetrievalEngine({ retrievers: [], reranker: crossEncoderReranker() })).toThrow(/textFor is required/);
  });
});

describe("retrieve", () => {
  const tiersOf: TierSource = { tiers: async (r) => [r.id, docs[r.id] ?? r.id] };
  const classOf = (r: FusedResult) => r.id.split(":")[0]!;
  const ftsEngine = async () => createRetrievalEngine({ retrievers: [ftsRetriever((await corpus()).spans)] });
  const context = (budget: { tokens: number }, limit?: number) => ({ mode: "context" as const, query: "vitest failing", budget, limit });

  it.each([1, 3])("list mode returns what search returns", async (limit) => {
    const { spans, edges, embedder, index } = await corpus();
    const fts = ftsRetriever(spans);
    const engine = createRetrievalEngine({
      retrievers: [fts, vectorRetriever(embedder, index), graphRetriever(edges, fts, { seedLimit: 1 })],
    });

    const listed = await engine.retrieve({ mode: "list", query: "vitest failing", limit });
    const searched = await engine.search("vitest failing", { limit });

    expect(listed.mode).toBe("list");
    if (listed.mode !== "list") throw new Error("unreachable");
    expect(listed.results).toEqual(searched.results);
    expect(listed.degraded).toEqual(searched.degraded);
    expect(Object.keys(listed.timingsMs).sort()).toEqual(Object.keys(searched.timingsMs).sort());
  });

  it("context mode plans within budget using categoryOf", async () => {
    const engine = await ftsEngine();

    const response = await engine.retrieve(context({ tokens: 12 }), { tierSource: tiersOf, categoryOf: classOf });
    const plain = await engine.retrieve(context({ tokens: 12 }), { tierSource: tiersOf });

    expect(response.mode).toBe("context");
    if (response.mode !== "context" || plain.mode !== "context") throw new Error("unreachable");
    expect(response.entries.map((e) => e.id).sort()).toEqual(["note:flaky", "note:vitest"]);
    expect(response.entries.every((e) => e.category === "note" && e.tier === 0)).toBe(true);
    expect(response.usedTokens).toBe(6);
    expect(response.budgetTokens).toBe(12);
    expect(plain.entries.every((e) => e.category === "fts")).toBe(true);
  });

  it("a tier source that throws drops that result as tier-error and degrades once", async () => {
    const engine = await ftsEngine();
    const flaky: TierSource = {
      tiers: (r) => {
        if (r.id === "note:flaky") throw new Error("tier file missing");
        return tiersOf.tiers(r);
      },
    };

    const response = await engine.retrieve(context({ tokens: 12 }), { tierSource: flaky, categoryOf: classOf });

    if (response.mode !== "context") throw new Error("unreachable");
    expect(response.entries.map((e) => e.id)).toEqual(["note:vitest"]);
    expect(response.dropped).toEqual([{ id: "note:flaky", category: "note", reason: "tier-error" }]);
    expect(response.degraded).toEqual([
      { retriever: TIERS_STAGE, reason: "error", message: "1 of 2 tier loads failed; first: tier file missing" },
    ]);
  });

  it("context mode keeps retriever degradations", async () => {
    const { spans, index } = await corpus();
    const down = { model: "dead", dimensions: 1, embed: async () => Promise.reject(new Error("ECONNREFUSED")) };
    const engine = createRetrievalEngine({ retrievers: [ftsRetriever(spans), vectorRetriever(down, index)] });

    const response = await engine.retrieve(context({ tokens: 40 }), { tierSource: tiersOf });

    if (response.mode !== "context") throw new Error("unreachable");
    expect(response.degraded).toEqual([{ retriever: "vector", reason: "error", message: "ECONNREFUSED" }]);
    expect(response.entries.length).toBeGreaterThan(0);
  });

  it("loads tiers only for the ranked candidates, not the overfetch", async () => {
    const { spans } = await corpus();
    for (let i = 0; i < 30; i++) {
      spans.index({ ownerRef: `session:s${i}`, field: "tool_result", sourceId: 2, byteOffset: i * 40, byteLength: 40 }, "vitest failing");
    }
    const engine = createRetrievalEngine({ retrievers: [ftsRetriever(spans)] });
    const spy = vi.fn(tiersOf.tiers);

    await engine.retrieve(context({ tokens: 200 }, 3), { tierSource: { tiers: spy } });

    const searched = await engine.search("vitest failing", { limit: 3 });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls.map(([r]) => r.id)).toEqual(searched.results.map((r) => r.id));
  });

  it("rejects a context request without a tier source before searching", async () => {
    const retrieve = vi.fn(async () => []);
    const engine = createRetrievalEngine({ retrievers: [{ name: "spy", retrieve }] });

    const missing = engine.retrieve({ mode: "context", query: "q", budget: { tokens: 10 } });
    await expect(missing).rejects.toThrow(TypeError);
    await expect(engine.retrieve({ mode: "context", query: "q", budget: { tokens: 10 } })).rejects.toThrow(/tierSource is required/);
    expect(retrieve).not.toHaveBeenCalled();
    const untyped = JSON.parse('{"mode":"list","query":"q","budget":{"tokens":10}}');
    await expect(engine.retrieve(untyped)).rejects.toThrow();
  });

  it("context mode costs with the injected estimator", async () => {
    const engine = await ftsEngine();

    const response = await engine.retrieve(context({ tokens: 12 }), { tierSource: tiersOf, categoryOf: classOf, estimateTokens: () => 1 });

    if (response.mode !== "context") throw new Error("unreachable");
    expect(response.entries.length).toBeGreaterThan(0);
    expect(response.usedTokens).toBe(response.entries.length);
    expect(response.entries.every((e) => e.tokens === 1)).toBe(true);
  });
});
