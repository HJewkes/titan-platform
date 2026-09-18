import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { HashEmbedder, type Embedder } from "@titan-design/embed";
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
function countingEmbedder(model = "nomic-embed-text"): Embedder & { calls: string[][] } {
  const inner = new HashEmbedder();
  const calls: string[][] = [];
  return {
    model,
    dimensions: inner.dimensions,
    calls,
    embed: (texts) => {
      calls.push([...texts]);
      return inner.embed(texts);
    },
  };
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

  it("prefixes the query with search_query for nomic models and not the stored texts", async () => {
    const embedder = countingEmbedder("nomic-embed-text");
    await embedSnapshot(store, snapshotId, embedder);

    await findSimilarCapability(store, snapshotId, "render a duration", embedder);

    expect(embedder.calls.at(-1)).toEqual(["search_query: render a duration"]);
    expect(embedder.calls.flat().filter((t) => t.startsWith("search_query: "))).toHaveLength(1);
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
