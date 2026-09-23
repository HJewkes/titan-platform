import type { Embedder } from "@titan-design/embed";
import { BruteForceVectorIndex, vectorRetriever } from "@titan-design/retrieval";
import { embedTextsCached } from "../embeddings/cache.js";
import { hashEmbedText } from "../embeddings/corpus.js";
import type { CodeGraphStore } from "../store.js";
import { getConventionMap } from "./summaries.js";
import type { ConventionArea, ConventionMatch, ConventionQueryResult, FindConventionsOptions } from "./types.js";

const MATCH_FILE_CAP = 5;
const DEFAULT_LIMIT = 3;

/**
 * "How does this repo do X?": rank summarized areas by similarity of their
 * summary to the question. Returns candidates, not verdicts. Summary vectors
 * share the content-addressed embedding cache with the symbol layer.
 */
export async function findConventions(
  store: CodeGraphStore,
  snapshotId: number,
  query: string,
  embedder: Embedder,
  model: string,
  opts: FindConventionsOptions = {},
): Promise<ConventionQueryResult> {
  const map = getConventionMap(store, snapshotId, model, opts);
  const summarized = map.areas.filter((a): a is ConventionArea & { summary: string } => Boolean(a.summary));
  if (summarized.length === 0) {
    throw new Error(`No convention summaries stored for model ${model}; run summarizeConventions first.`);
  }
  const { byHash } = await embedTextsCached(store, embedder, summarized.map((a) => a.summary));
  const index = new BruteForceVectorIndex();
  for (const area of summarized) index.add(area.id, byHash.get(hashEmbedText(area.summary))!);
  const hits = await vectorRetriever(embedder, index).retrieve(query, { limit: opts.limit ?? DEFAULT_LIMIT });
  const byId = new Map(summarized.map((a) => [a.id, a]));
  return {
    query,
    model,
    embeddingModel: embedder.model,
    coverage: map.coverage,
    matches: hits.map((h) => toMatch(byId.get(h.id)!, h.score ?? 0)),
  };
}

function toMatch(area: ConventionArea & { summary: string }, score: number): ConventionMatch {
  return {
    id: area.id,
    label: area.label,
    summary: area.summary,
    files: area.files.slice(0, MATCH_FILE_CAP),
    size: area.size,
    score,
  };
}
