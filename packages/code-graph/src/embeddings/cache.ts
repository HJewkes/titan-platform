import { fromFloat32Buffer, normalize, toFloat32Buffer, type Embedder } from "@titan-design/embed";
import { CacheBlobTable } from "@titan-design/store-sqlite";
import { KIT } from "../schema.js";
import type { CodeGraphStore } from "../store.js";
import { hashEmbedText } from "./corpus.js";

/** The blob_cache namespace for symbol vectors; the model column keys the vector space. */
export const SYMBOL_EMBEDDING_NAMESPACE = "code-graph/symbol-embedding";

const EMBED_BATCH_SIZE = 64;

export interface CachedEmbedResult {
  /** L2-normalized vectors for every input text, keyed by its text hash. */
  byHash: Map<string, number[]>;
  /** Hashes that had no stored vector and were embedded on this call. */
  newHashes: Set<string>;
}

function symbolVectorCache(store: CodeGraphStore): CacheBlobTable {
  return new CacheBlobTable(store.db, { name: KIT.cacheBlob });
}

export function loadVectorsByHash(
  store: CodeGraphStore,
  model: string,
  hashes: readonly string[],
): Map<string, number[]> {
  const cache = symbolVectorCache(store);
  const found = new Map<string, number[]>();
  for (const contentHash of new Set(hashes)) {
    const hit = cache.get({ namespace: SYMBOL_EMBEDDING_NAMESPACE, model, contentHash });
    if (hit) found.set(contentHash, fromFloat32Buffer(hit.value));
  }
  return found;
}

function storeVectors(
  store: CodeGraphStore,
  model: string,
  rows: ReadonlyArray<{ textHash: string; vector: number[] }>,
): void {
  const cache = symbolVectorCache(store);
  store.db.transaction(() => {
    for (const r of rows) {
      const key = { namespace: SYMBOL_EMBEDDING_NAMESPACE, model, contentHash: r.textHash };
      cache.put(key, toFloat32Buffer(r.vector), { dims: r.vector.length });
    }
  })();
}

/**
 * Embed texts through the content-addressed store: only texts whose hash has
 * no vector for this model reach the embedder; new vectors are normalized and
 * persisted batch by batch so the next call (or a retry after a failure) is a cache hit.
 */
export async function embedTextsCached(
  store: CodeGraphStore,
  embedder: Embedder,
  texts: readonly string[],
): Promise<CachedEmbedResult> {
  const hashes = texts.map((t) => hashEmbedText(t));
  const byHash = loadVectorsByHash(store, embedder.model, hashes);
  const missing = new Map<string, string>();
  texts.forEach((text, i) => {
    if (!byHash.has(hashes[i]!)) missing.set(hashes[i]!, text);
  });
  const pending = [...missing.entries()];
  for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
    const rows = await embedBatch(embedder, pending.slice(i, i + EMBED_BATCH_SIZE));
    storeVectors(store, embedder.model, rows);
    for (const r of rows) byHash.set(r.textHash, r.vector);
  }
  return { byHash, newHashes: new Set(missing.keys()) };
}

async function embedBatch(
  embedder: Embedder,
  batch: ReadonlyArray<[string, string]>,
): Promise<Array<{ textHash: string; vector: number[] }>> {
  const vectors = await embedder.embed(batch.map(([, text]) => text));
  if (vectors.length !== batch.length) {
    throw new Error(`Embedder returned ${vectors.length} vectors for ${batch.length} texts`);
  }
  return batch.map(([textHash], j) => ({ textHash, vector: normalize(vectors[j]!) }));
}
