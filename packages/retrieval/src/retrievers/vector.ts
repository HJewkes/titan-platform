import { cosineSimilarity, type Embedder } from "@titan-design/embed";
import type { Hit, RetrieveOptions, Retriever } from "../types.js";

export interface VectorMatch {
  id: string;
  similarity: number;
}

/** Nearest-neighbour lookup. Implement over sqlite-vec, a brute-force scan, or a remote index. */
export interface VectorIndex {
  search(vector: number[], limit: number): Promise<VectorMatch[]>;
}

/**
 * Exact cosine search over vectors held in memory. Fine to tens of thousands of
 * rows; past that, back it with sqlite-vec behind the same interface.
 */
export class BruteForceVectorIndex implements VectorIndex {
  private readonly rows = new Map<string, number[]>();

  add(id: string, vector: number[]): void {
    this.rows.set(id, vector);
  }

  remove(id: string): void {
    this.rows.delete(id);
  }

  get size(): number {
    return this.rows.size;
  }

  async search(vector: number[], limit: number): Promise<VectorMatch[]> {
    const scored: VectorMatch[] = [];
    for (const [id, row] of this.rows) scored.push({ id, similarity: cosineSimilarity(vector, row) });
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
  }
}

export interface VectorRetrieverOptions {
  name?: string;
  /** Prepended to the query before embedding; nomic models expect `search_query: `. */
  queryPrefix?: string;
  /** Drop matches below this cosine similarity. */
  minSimilarity?: number;
}

export function vectorRetriever(embedder: Embedder, index: VectorIndex, options: VectorRetrieverOptions = {}): Retriever {
  const prefix = options.queryPrefix ?? (embedder.model.includes("nomic") ? "search_query: " : "");
  const minSimilarity = options.minSimilarity ?? -Infinity;
  return {
    name: options.name ?? "vector",
    async retrieve(query: string, { limit }: RetrieveOptions): Promise<Hit[]> {
      const [vector] = await embedder.embed([`${prefix}${query}`]);
      if (!vector) return [];
      const matches = await index.search(vector, limit);
      return matches
        .filter((m) => m.similarity >= minSimilarity)
        .map((m, i) => ({ id: m.id, rank: i + 1, score: m.similarity, payload: { similarity: m.similarity } }));
    },
  };
}
