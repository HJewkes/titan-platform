import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { Embedder } from "@titan-design/embed";
import { CacheBlobTable } from "@titan-design/store-sqlite";
import { KIT } from "../schema.js";
import { openCodeGraph, type CodeGraphStore } from "../store.js";
import { buildConventionAreas, defaultTargetCount } from "./areas.js";
import { findConventions } from "./query.js";
import { COMMUNITY_SUMMARY_NAMESPACE, getConventionMap, summarizeConventions } from "./summaries.js";
import type { Summarizer } from "./types.js";

/** Canned summarizer: answers by the area label line in the prompt, counts calls. */
function fakeSummarizer(model = "fake-summary"): Summarizer & { calls: string[] } {
  const calls: string[] = [];
  return {
    model,
    calls,
    summarize: (prompt) => {
      calls.push(prompt);
      const label = /^Capability area: (.+)$/m.exec(prompt)?.[1] ?? "?";
      return Promise.resolve(`  Summary of ${label}.\n`);
    },
  };
}

/** Deterministic hash embedder: identical text gives an identical vector. */
const hashEmbedder: Embedder = {
  model: "fake-embed",
  dimensions: 8,
  embed: (texts) =>
    Promise.resolve(
      texts.map((t) => {
        const bytes = createHash("sha256").update(t, "utf8").digest();
        return Array.from(bytes.subarray(0, 8), (b) => b / 255 - 0.5);
      }),
    ),
};

/** Two separated clusters, src/dates and src/http, plus an isolated file and a generated file. */
function insertFixture(store: CodeGraphStore, ref = "wd"): number {
  const snap = store.createSnapshot({ ref, indexVersion: "0.11.0" });
  const clusters: Record<string, string[]> = {
    "src/dates": ["format.ts", "parse.ts", "index.ts"],
    "src/http": ["client.ts", "retry.ts", "headers.ts"],
  };
  for (const [dir, names] of Object.entries(clusters)) {
    store.insertNodes(snap, names.map((name) => ({ id: `${dir}/${name}`, kind: "file" as const, name })));
    const [a, b, c] = names.map((n) => `${dir}/${n}`) as [string, string, string];
    store.insertEdges(snap, [
      { srcId: a, dstId: b, kind: "imports" },
      { srcId: b, dstId: c, kind: "imports" },
      { srcId: c, dstId: a, kind: "imports" },
    ]);
  }
  store.insertNodes(snap, [
    { id: "src/lonely.ts", kind: "file", name: "lonely.ts" },
    { id: "src/api.gen.ts", kind: "file", name: "api.gen.ts", role: "generated" },
    {
      id: "src/dates/format.ts#formatDuration",
      kind: "symbol",
      name: "formatDuration",
      parentId: "src/dates/format.ts",
      attrs: { exported: true, signature: "formatDuration(ms: number): string", purpose: "Render a duration as 1h30m" },
    },
    {
      id: "src/http/client.ts#request",
      kind: "symbol",
      name: "request",
      parentId: "src/http/client.ts",
      attrs: { exported: true, signature: "request(url: string): Promise<Response>" },
    },
  ]);
  return snap;
}

describe("conventions", () => {
  let dbDir: string;
  let store: CodeGraphStore;

  beforeEach(async () => {
    dbDir = await fs.mkdtemp(path.join(tmpdir(), "code-graph-conv-"));
    store = openCodeGraph(path.join(dbDir, "graph.db"));
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dbDir, { recursive: true, force: true });
  });

  it("scales the default area target with repo size", () => {
    expect(defaultTargetCount(50)).toBe(6);
    expect(defaultTargetCount(746)).toBe(30);
    expect(defaultTargetCount(5000)).toBe(40);
  });

  it("partitions into labeled areas and leaves small/generated files ungrouped", () => {
    const snap = insertFixture(store);
    const { areas, coverage, prompts } = buildConventionAreas(store, snap);
    expect(areas.map((a) => a.label)).toEqual(["src/dates", "src/http"]);
    expect(areas.every((a) => a.size === 3)).toBe(true);
    // 7 eligible files (generated excluded); lonely.ts below minSize stays out.
    expect(coverage).toEqual({ files: 7, grouped: 6, areas: 2, summarized: 0 });
    const dates = areas[0]!;
    expect(dates.topSymbols).toEqual([
      { name: "formatDuration", signature: "formatDuration(ms: number): string", purpose: "Render a duration as 1h30m" },
    ]);
    expect(dates.id).toMatch(/^area-[0-9a-f]{8}$/);
    expect(prompts.get(dates.contentHash)).toContain("formatDuration(ms: number): string — Render a duration as 1h30m");
    expect(prompts.get(dates.contentHash)).not.toContain("src/lonely.ts");
  });

  it("summarizes each area once and reuses the content-addressed cache", async () => {
    const snap = insertFixture(store);
    const summarizer = fakeSummarizer();
    const first = await summarizeConventions(store, snap, summarizer);
    expect(first.newlySummarized).toBe(2);
    expect(first.reused).toBe(0);
    expect(first.areas.map((a) => a.summary)).toEqual(["Summary of src/dates.", "Summary of src/http."]);

    const again = await summarizeConventions(store, snap, summarizer);
    expect(again.newlySummarized).toBe(0);
    expect(again.reused).toBe(2);
    expect(summarizer.calls).toHaveLength(2);

    // A new snapshot with identical structure is also a full cache hit.
    const snap2 = insertFixture(store, "wd2");
    const cross = await summarizeConventions(store, snap2, summarizer);
    expect(cross.newlySummarized).toBe(0);
    expect(summarizer.calls).toHaveLength(2);
  });

  it("getConventionMap reads stored summaries without a summarizer", async () => {
    const snap = insertFixture(store);
    const summarizer = fakeSummarizer();
    expect(getConventionMap(store, snap, summarizer.model).coverage.summarized).toBe(0);
    await summarizeConventions(store, snap, summarizer);
    const map = getConventionMap(store, snap, summarizer.model);
    expect(map.coverage.summarized).toBe(2);
    expect(map.areas[0]!.summary).toBe("Summary of src/dates.");
  });

  it("findConventions ranks the matching area first (and needs summaries)", async () => {
    const snap = insertFixture(store);
    const summarizer = fakeSummarizer();
    await expect(
      findConventions(store, snap, "how are dates formatted?", hashEmbedder, summarizer.model),
    ).rejects.toThrow(/summarizeConventions/);

    await summarizeConventions(store, snap, summarizer);
    // The exact summary text must rank its own area at ~1.0.
    const result = await findConventions(store, snap, "Summary of src/dates.", hashEmbedder, summarizer.model, {
      limit: 1,
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.label).toBe("src/dates");
    expect(result.matches[0]!.score).toBeCloseTo(1, 5);
    expect(result.embeddingModel).toBe("fake-embed");
  });

  it("coarsens to targetCount when asked", () => {
    const snap = insertFixture(store);
    // The two clusters are disconnected, so 2 is the reachable floor.
    const { areas } = buildConventionAreas(store, snap, { targetCount: 1 });
    expect(areas).toHaveLength(2);
  });
});

describe("conventions summary storage", () => {
  let dbDir: string;
  let store: CodeGraphStore;

  beforeEach(async () => {
    dbDir = await fs.mkdtemp(path.join(tmpdir(), "code-graph-conv-"));
    store = openCodeGraph(path.join(dbDir, "graph.db"));
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dbDir, { recursive: true, force: true });
  });

  it("stores summaries in blob_cache under the community-summary namespace, keyed by model", async () => {
    const snap = insertFixture(store);
    await summarizeConventions(store, snap, fakeSummarizer("model-a"));
    const cache = new CacheBlobTable(store.db, { name: KIT.cacheBlob });
    expect(cache.count(COMMUNITY_SUMMARY_NAMESPACE, "model-a")).toBe(2);
    expect(cache.count(COMMUNITY_SUMMARY_NAMESPACE, "model-b")).toBe(0);
  });

  it("treats a different summarizer model as a cache miss", async () => {
    const snap = insertFixture(store);
    await summarizeConventions(store, snap, fakeSummarizer("model-a"));
    const other = fakeSummarizer("model-b");
    const result = await summarizeConventions(store, snap, other);
    expect(result.newlySummarized).toBe(2);
    expect(other.calls).toHaveLength(2);
    expect(getConventionMap(store, snap, "model-c").coverage.summarized).toBe(0);
  });

  it("re-summarizes only the area whose membership changed", async () => {
    const snap = insertFixture(store);
    const summarizer = fakeSummarizer();
    await summarizeConventions(store, snap, summarizer);
    const snap2 = insertFixture(store, "wd2");
    store.insertNodes(snap2, [{ id: "src/http/cookies.ts", kind: "file", name: "cookies.ts" }]);
    store.insertEdges(snap2, [{ srcId: "src/http/cookies.ts", dstId: "src/http/client.ts", kind: "imports" }]);
    const result = await summarizeConventions(store, snap2, summarizer);
    expect(result.newlySummarized).toBe(1);
    expect(result.reused).toBe(1);
    expect(summarizer.calls.at(-1)).toContain("src/http/cookies.ts");
  });
});
