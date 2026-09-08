import type { SpanFtsTables } from "@titan-design/store-sqlite";
import type { Hit, RetrieveOptions, Retriever } from "../types.js";

export interface FtsRetrieverOptions {
  name?: string;
  /** Turn a free-text query into an FTS5 MATCH expression. The default quotes each word and ORs them. */
  toMatchExpression?: (query: string) => string;
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
      const seen = new Set<string>();
      const hits: Hit[] = [];
      for (const span of spans.search(expression, limit * 4)) {
        if (seen.has(span.ownerRef)) continue;
        seen.add(span.ownerRef);
        hits.push({
          id: span.ownerRef,
          rank: hits.length + 1,
          score: -span.rank,
          payload: { spanId: span.spanId, field: span.field, sourceId: span.sourceId, byteOffset: span.byteOffset, byteLength: span.byteLength },
        });
        if (hits.length >= limit) break;
      }
      return hits;
    },
  };
}
