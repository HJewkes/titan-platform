import type { Embedder } from "@titan-design/embed";
import { BruteForceVectorIndex, vectorRetriever } from "@titan-design/retrieval";
import type { CodeGraphStore } from "../store.js";
import { embedTextsCached, loadVectorsByHash } from "./cache.js";
import { listEmbeddableSymbols } from "./corpus.js";
import type {
  EmbedAttempt,
  EmbeddableSymbol,
  EmbedSnapshotResult,
  FindSimilarOptions,
  SimilarCandidate,
  SimilarResult,
} from "./types.js";

/**
 * Precompute capability embeddings for a snapshot. Only texts whose hash has no
 * stored vector are sent to the embedder, so re-runs and unchanged symbols cost
 * nothing: the content-addressed store is the incremental-reuse mechanism.
 */
export async function embedSnapshot(
  store: CodeGraphStore,
  snapshotId: number,
  embedder: Embedder,
): Promise<EmbedSnapshotResult> {
  const symbols = listEmbeddableSymbols(store, snapshotId);
  const { newHashes } = await embedTextsCached(store, embedder, symbols.map((s) => s.text));
  return {
    model: embedder.model,
    symbols: symbols.length,
    withPurpose: symbols.filter((s) => s.purpose).length,
    embedded: symbols.length,
    newlyEmbedded: newHashes.size,
    reused: symbols.filter((s) => !newHashes.has(s.textHash)).length,
  };
}

/**
 * The post-index pass. A backend failure (ollama down, model missing) must not
 * fail the index: the snapshot is already persisted and valid without vectors.
 */
export async function tryEmbedSnapshot(
  store: CodeGraphStore,
  snapshotId: number,
  embedder: Embedder,
): Promise<EmbedAttempt> {
  try {
    return { ok: true, result: await embedSnapshot(store, snapshotId, embedder) };
  } catch (err) {
    return { ok: false, model: embedder.model, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The query-time "about to write X: does it exist?" surface. Embeds the query
 * (an intent sentence, a pseudo-signature, or both as `sig -- intent`), ranks
 * the snapshot's embedded symbols by cosine similarity, and returns the top-K
 * with coverage so the caller can weigh how much of the repo was searchable.
 */
export async function findSimilarCapability(
  store: CodeGraphStore,
  snapshotId: number,
  query: string,
  embedder: Embedder,
  opts: FindSimilarOptions = {},
): Promise<SimilarResult> {
  const symbols = listEmbeddableSymbols(store, snapshotId);
  const index = buildSymbolIndex(store, embedder.model, symbols);
  if (index.size === 0) {
    throw new Error(
      `No capability embeddings stored for snapshot ${snapshotId} ` +
        `(model ${embedder.model}); run embedSnapshot first.`,
    );
  }
  const retriever = vectorRetriever(embedder, index, { queryPrefix: opts.queryPrefix });
  const hits = await retriever.retrieve(query, { limit: opts.limit ?? 10 });
  const byId = new Map(symbols.map((s) => [s.id, s]));
  return {
    query,
    model: embedder.model,
    coverage: { symbols: symbols.length, embedded: index.size, withPurpose: symbols.filter((s) => s.purpose).length },
    candidates: hits.map((h) => toCandidate(byId.get(h.id)!, h.score ?? 0)),
  };
}

function buildSymbolIndex(
  store: CodeGraphStore,
  model: string,
  symbols: readonly EmbeddableSymbol[],
): BruteForceVectorIndex {
  const vectors = loadVectorsByHash(store, model, symbols.map((s) => s.textHash));
  const index = new BruteForceVectorIndex();
  for (const s of symbols) {
    const vector = vectors.get(s.textHash);
    if (vector) index.add(s.id, vector);
  }
  return index;
}

function toCandidate(s: EmbeddableSymbol, score: number): SimilarCandidate {
  return { id: s.id, name: s.name, file: s.file, signature: s.signature, purpose: s.purpose, score };
}
