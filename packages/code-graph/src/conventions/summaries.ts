import { CacheBlobTable } from "@titan-design/store-sqlite";
import { KIT } from "../schema.js";
import type { CodeGraphStore } from "../store.js";
import { buildConventionAreas } from "./areas.js";
import type {
  ConventionArea,
  ConventionMap,
  ConventionOptions,
  SummarizeConventionsResult,
  Summarizer,
} from "./types.js";

/** The blob_cache namespace for area summaries; the model column holds `summarizer.model`. */
export const COMMUNITY_SUMMARY_NAMESPACE = "code-graph/community-summary";

function summaryCache(store: CodeGraphStore): CacheBlobTable {
  return new CacheBlobTable(store.db, { name: KIT.cacheBlob });
}

function loadSummaries(store: CodeGraphStore, model: string, hashes: readonly string[]): Map<string, string> {
  const cache = summaryCache(store);
  const found = new Map<string, string>();
  for (const contentHash of new Set(hashes)) {
    const hit = cache.get({ namespace: COMMUNITY_SUMMARY_NAMESPACE, model, contentHash });
    if (hit) found.set(contentHash, hit.value.toString("utf8"));
  }
  return found;
}

function storeSummary(store: CodeGraphStore, model: string, contentHash: string, summary: string): void {
  summaryCache(store).put({ namespace: COMMUNITY_SUMMARY_NAMESPACE, model, contentHash }, summary);
}

function attachSummaries(areas: ConventionArea[], summaries: ReadonlyMap<string, string>): void {
  for (const area of areas) area.summary = summaries.get(area.contentHash);
}

/**
 * Generate or reuse the summary of every area. Only cache misses reach the
 * summarizer, so cost scales with what structurally changed, not with repo size.
 */
export async function summarizeConventions(
  store: CodeGraphStore,
  snapshotId: number,
  summarizer: Summarizer,
  opts?: ConventionOptions,
): Promise<SummarizeConventionsResult> {
  const { areas, prompts, coverage } = buildConventionAreas(store, snapshotId, opts);
  attachSummaries(areas, loadSummaries(store, summarizer.model, areas.map((a) => a.contentHash)));
  let newlySummarized = 0;
  for (const area of areas) {
    if (area.summary !== undefined) continue;
    const summary = (await summarizer.summarize(prompts.get(area.contentHash)!)).trim();
    storeSummary(store, summarizer.model, area.contentHash, summary);
    area.summary = summary;
    newlySummarized++;
  }
  coverage.summarized = areas.filter((a) => a.summary).length;
  return { model: summarizer.model, coverage, areas, newlySummarized, reused: areas.length - newlySummarized };
}

/** Read-only view: the partition plus whatever summaries are already stored. Never calls a summarizer. */
export function getConventionMap(
  store: CodeGraphStore,
  snapshotId: number,
  model: string,
  opts?: ConventionOptions,
): ConventionMap {
  const { areas, coverage } = buildConventionAreas(store, snapshotId, opts);
  attachSummaries(areas, loadSummaries(store, model, areas.map((a) => a.contentHash)));
  coverage.summarized = areas.filter((a) => a.summary).length;
  return { model, coverage, areas };
}
