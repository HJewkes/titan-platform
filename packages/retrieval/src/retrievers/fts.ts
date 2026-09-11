import type { SpanFtsTables, SpanScope } from "@titan-design/store-sqlite";
import type { Hit, RetrieveOptions, Retriever } from "../types.js";

export interface FtsRetrieverOptions {
  name?: string;
  /** Turn a free-text query into an FTS5 MATCH expression. The default quotes each word and ORs them. */
  toMatchExpression?: (query: string) => string;
  /**
   * Restrict this retriever to one class of owner, so it becomes one ranked
   * list among several rather than the whole index.
   *
   * Register one scoped retriever per class and let RRF fuse them. Rank is
   * computed within a list, so a class of 92,713 spans cannot swamp a class of
   * 1,569: it only ever contributes its own top-N. One pooled retriever over
   * the same tables returns the large class and nothing else.
   */
  scope?: SpanScope;
  /**
   * Hard ceiling on hits from this retriever, whatever the engine asks for.
   *
   * The engine's overfetch is uniform across retrievers, which is the wrong
   * shape for a class prior: some classes are duplicate content of others and
   * should contribute a handful of candidates at most. A cap says that in one
   * number, and it composes with `fusion.weights` rather than replacing it —
   * the weight sets how much a hit counts, the cap sets how many there are.
   */
  cap?: number;
}

/** Quote tokens so punctuation in user text cannot break FTS5 syntax; OR them for recall. */
export function defaultMatchExpression(query: string): string {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return terms.map((t) => `"${t}"`).join(" OR ");
}

/**
 * BM25 over a contentless span index. Several spans of one owner collapse to
 * the owner's best rank, and the winning span's locator rides along as payload.
 */
export function ftsRetriever(spans: SpanFtsTables, options: FtsRetrieverOptions = {}): Retriever {
  const toMatch = options.toMatchExpression ?? defaultMatchExpression;
  return {
    name: options.name ?? "fts",
    async retrieve(query: string, { limit }: RetrieveOptions): Promise<Hit[]> {
      const expression = toMatch(query);
      if (expression.length === 0) return [];
      const effective = options.cap === undefined ? limit : Math.min(limit, options.cap);
      if (effective <= 0) return [];
      const seen = new Set<string>();
      const hits: Hit[] = [];
      // Overfetch spans, not owners: several spans of one owner collapse.
      for (const span of spans.search(expression, effective * 4, options.scope)) {
        if (seen.has(span.ownerRef)) continue;
        seen.add(span.ownerRef);
        hits.push({
          id: span.ownerRef,
          rank: hits.length + 1,
          score: -span.rank,
          payload: { spanId: span.spanId, field: span.field, sourceId: span.sourceId, byteOffset: span.byteOffset, byteLength: span.byteLength },
        });
        if (hits.length >= effective) break;
      }
      return hits;
    },
  };
}
