import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { HashEmbedder, OllamaEmbedder, type EmbedRole, type Embedder } from "@titan-design/embed";
import { indexPaths } from "../indexer.js";
import { openCodeGraph, type CodeGraphStore } from "../store.js";
import { SYMBOL_EMBEDDING_NAMESPACE } from "./cache.js";
import { embedSnapshot, findSimilarCapability, tryEmbedSnapshot } from "./embeddings.js";

const DURATION_TS = `/** Render a duration in milliseconds as a compact string like 1h30m. */
export function formatDuration(ms: number): string {
  return String(ms);
}

/** Parse an ISO date string into epoch milliseconds. */
export function parseIsoDate(text: string): number {
  return Date.parse(text);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
`;

/** Counts every text it is asked to embed; vectors come from the lexical hash backend. */
function countingEmbedder(model = "nomic-embed-text"): Embedder & { calls: string[][]; roles: EmbedRole[] } {
  const inner = new HashEmbedder();
  const calls: string[][] = [];
  const roles: EmbedRole[] = [];
  return {
    model,
    dimensions: inner.dimensions,
    calls,
    roles,
    embed: (texts, options) => {
      calls.push([...texts]);
      roles.push(options?.role ?? "document");
      return inner.embed(texts);
    },
  };
}

/** A real OllamaEmbedder over a fake fetch that serves hash vectors and records what reached the backend. */
function fakeOllama(prefixes?: { document?: string; query?: string }): { embedder: OllamaEmbedder; inputs: string[] } {
  const hash = new HashEmbedder();
  const inputs: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    inputs.push(...input);
    return new Response(JSON.stringify({ embeddings: await hash.embed(input) }), { status: 200 });
  }) as typeof fetch;
  return { embedder: new OllamaEmbedder({ dimensions: hash.dimensions, fetch: fetchImpl, prefixes }), inputs };
}

function failingEmbedder(): Embedder {
  return { model: "down-model", dimensions: 4, embed: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:11434")) };
}

describe("embeddings over an indexed snapshot", () => {
  let root: string;
  let store: CodeGraphStore;
  let snapshotId: number;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), "code-graph-emb-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src/time.ts"), DURATION_TS);
    store = openCodeGraph(path.join(root, "graph.sqlite3"));
    ({ snapshotId } = await indexPaths(store, { paths: [root], ref: "wd", detectRenames: false }));
  });

  afterEach(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("embeds a real snapshot once and makes zero embed calls on the second run", async () => {
    const embedder = countingEmbedder();

    const first = await embedSnapshot(store, snapshotId, embedder);
    const callsAfterFirst = embedder.calls.length;
    const second = await embedSnapshot(store, snapshotId, embedder);

    expect(first).toMatchObject({ symbols: 3, withPurpose: 2, newlyEmbedded: 3, reused: 0 });
    expect(embedder.calls.flat()).toContain(
      "formatDuration(ms: number): string -- Render a duration in milliseconds as a compact string like 1h30m.",
    );
    expect(second).toMatchObject({ symbols: 3, newlyEmbedded: 0, reused: 3 });
    expect(embedder.calls).toHaveLength(callsAfterFirst);
  });

  it("stores vectors in the blob cache under the symbol namespace and the embedder's model", async () => {
    await embedSnapshot(store, snapshotId, countingEmbedder("model-a"));

    const rows = store.db
      .prepare("SELECT namespace, model, count(*) AS n FROM blob_cache GROUP BY namespace, model")
      .all();

    expect(rows).toEqual([{ namespace: SYMBOL_EMBEDDING_NAMESPACE, model: "model-a", n: 3 }]);
  });

  it("reports a down backend instead of throwing, and leaves the snapshot searchable later", async () => {
    const attempt = await tryEmbedSnapshot(store, snapshotId, failingEmbedder());

    expect(attempt).toEqual({ ok: false, model: "down-model", error: "connect ECONNREFUSED 127.0.0.1:11434" });
    expect(store.getSnapshot(snapshotId)).not.toBeNull();
    await expect(tryEmbedSnapshot(store, snapshotId, countingEmbedder())).resolves.toMatchObject({ ok: true });
  });

  it("hands the query to the embedder verbatim with role query, and stored texts with role document", async () => {
    const embedder = countingEmbedder("nomic-embed-text");
    await embedSnapshot(store, snapshotId, embedder);

    await findSimilarCapability(store, snapshotId, "render a duration", embedder);

    expect(embedder.calls.at(-1)).toEqual(["render a duration"]);
    expect(embedder.roles).toEqual(["document", "query"]);
  });

  it("sends each text to a default nomic backend with exactly one prefix", async () => {
    const { embedder, inputs } = fakeOllama();
    await embedSnapshot(store, snapshotId, embedder);

    await findSimilarCapability(store, snapshotId, "render a duration", embedder);

    expect(inputs.at(-1)).toBe("search_query: render a duration");
    expect(inputs.slice(0, -1).every((t) => t.startsWith("search_document: ") && !t.includes("search_query"))).toBe(true);
  });

  it("never shares a cache entry between two prefix configurations of one model", async () => {
    const nomic = fakeOllama();
    const raw = fakeOllama({ document: "", query: "" });

    await embedSnapshot(store, snapshotId, nomic.embedder);
    const second = await embedSnapshot(store, snapshotId, raw.embedder);

    expect(second).toMatchObject({ newlyEmbedded: 3, reused: 0 });
    const rows = store.db.prepare("SELECT DISTINCT model FROM blob_cache ORDER BY model").all() as { model: string }[];
    expect(rows.map((r) => r.model)).toEqual([nomic.embedder.model, raw.embedder.model].sort());
  });

  it("does not serve vectors cached under the bare pre-0.2 model name", async () => {
    await embedSnapshot(store, snapshotId, countingEmbedder("nomic-embed-text"));

    await expect(findSimilarCapability(store, snapshotId, "render", fakeOllama().embedder)).rejects.toThrow(
      /No capability embeddings/,
    );
  });

  it("ranks the lexically closest symbol first with the hash backend", async () => {
    const embedder = new HashEmbedder();
    await embedSnapshot(store, snapshotId, embedder);

    const result = await findSimilarCapability(store, snapshotId, "render a duration in milliseconds", embedder, { limit: 2 });

    expect(result.candidates[0]).toMatchObject({ id: "src/time.ts#formatDuration", file: "src/time.ts" });
    expect(result.candidates).toHaveLength(2);
    expect(result.coverage).toEqual({ symbols: 3, embedded: 3, withPurpose: 2 });
  });
});
