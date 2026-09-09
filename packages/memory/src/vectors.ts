import { fromFloat32Buffer, toFloat32Buffer, type Embedder } from "@titan-design/embed";
import { BruteForceVectorIndex, type VectorIndex } from "@titan-design/retrieval";
import { CacheBlobTable, type Db } from "@titan-design/store-sqlite";
import { DEFAULT_MEMORY_TABLES, type MemoryTables } from "./schema.js";
import { normalizeContent } from "./text.js";
import type { Bullet } from "./types.js";

export interface MemoryVectorsOptions {
  tables?: MemoryTables;
  namespace?: string;
}

/**
 * Bullet embeddings in cache_blob, keyed by normalized content and the
 * embedder's model, so a re-worded bullet re-embeds and everything else is a
 * cache hit. The index is rebuilt from the cache; nothing is stored twice.
 */
export class MemoryVectors {
  private readonly cache: CacheBlobTable;
  private readonly namespace: string;

  constructor(
    db: Db,
    private readonly embedder: Embedder,
    options: MemoryVectorsOptions = {},
  ) {
    this.cache = new CacheBlobTable(db, { name: (options.tables ?? DEFAULT_MEMORY_TABLES).cacheBlob });
    this.namespace = options.namespace ?? "memory:bullet";
  }

  /** Embed every bullet the cache does not have, in one call. Returns how many were computed. */
  async ensure(bullets: readonly Bullet[]): Promise<number> {
    const missing = bullets.filter((b) => this.cache.get(this.keyFor(b)) === undefined);
    if (missing.length === 0) return 0;
    const vectors = await this.embedder.embed(missing.map((b) => normalizeContent(b.content)));
    missing.forEach((bullet, i) => {
      const vector = vectors[i];
      if (vector) this.cache.put(this.keyFor(bullet), toFloat32Buffer(vector), { bulletId: bullet.id });
    });
    return missing.length;
  }

  /** A searchable index over these bullets, embedding any misses first. */
  async index(bullets: readonly Bullet[]): Promise<VectorIndex> {
    await this.ensure(bullets);
    const index = new BruteForceVectorIndex();
    for (const bullet of bullets) {
      const hit = this.cache.get(this.keyFor(bullet));
      if (hit) index.add(bullet.id, fromFloat32Buffer(hit.value));
    }
    return index;
  }

  private keyFor(bullet: Bullet): { namespace: string; model: string; text: string } {
    return { namespace: this.namespace, model: this.embedder.model, text: normalizeContent(bullet.content) };
  }
}
