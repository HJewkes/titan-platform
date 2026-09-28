import type { CodeReadCommandMap, MetricDescriptor } from "@titan-design/code-read/query";
import { PAGE_SIZE } from "./page-size.js";

type Args<K extends keyof CodeReadCommandMap> = CodeReadCommandMap[K]["args"];

/** A node page shows a short list, not a page of one; the search box shows a few candidates. */
export const NODE_LIST_LIMIT = 10;
export const SEARCH_LIMIT = 8;

/** Kinds code-graph stores; a directory and the repo are synthesized, and have no edges of their own. */
const STORED_KINDS = new Set(["file", "symbol", "module", "external"]);

export function isStoredKind(kind: string): boolean {
  return STORED_KINDS.has(kind);
}

/** Children of a file or symbol are symbols, so the columns are symbol metrics. */
export function childMetrics(kind: string): string[] {
  return kind === "file" || kind === "symbol" ? ["symbol_cognitive", "symbol_cyclomatic"] : ["loc", "cognitive_sum"];
}

/**
 * The args each page sends, in one place, so the exporter records exactly the keys a page will ask for.
 * A static page that asks anything else still answers, through the dataset resolver.
 */
export const CALLS = {
  describe: (): Args<"api.describe"> => ({}),
  findingCounts: (snapshot: number): Args<"findings.list"> => ({ snapshot, limit: 0, facets: true }),
  overviewTree: (snapshot: number, metrics: readonly string[]): Args<"hierarchy.get"> => ({ snapshot, depth: 2, metrics: [...metrics] }),
  findingsPage: (snapshot: number, filters: FindingFilters, sort: SortKey, offset: number): Args<"findings.list"> => ({
    snapshot, ...filters, sort, offset, limit: PAGE_SIZE,
  }),
  finding: (snapshot: number, id: string): Args<"finding.get"> => ({ snapshot, id }),
  node: (snapshot: number, id: string): Args<"node.get"> => ({ snapshot, id }),
  nodeTree: (snapshot: number, id: string, metrics: readonly string[]): Args<"hierarchy.get"> => ({
    snapshot, root: id, depth: 1, metrics: [...metrics], include_symbols: true,
  }),
  nodeFindings: (snapshot: number, id: string): Args<"findings.list"> => ({ snapshot, scope: id, limit: NODE_LIST_LIMIT }),
  nodeNeighbors: (snapshot: number, id: string): Args<"node.neighbors"> => ({ snapshot, id, limit: NODE_LIST_LIMIT }),
  search: (snapshot: number, query: string): Args<"node.resolve"> => ({ snapshot, query, limit: SEARCH_LIMIT }),
};

export type SortKey = NonNullable<Args<"findings.list">["sort"]>;

export interface FindingFilters {
  rule: string[];
  severity: string[];
  kind: string[];
  provenance: NonNullable<Args<"findings.list">["provenance"]>;
}

export const NO_FILTERS: FindingFilters = { rule: [], severity: [], kind: [], provenance: [] };

/** Size, complexity, and change: the columns the research says lead a code-health overview. */
const OVERVIEW_METRICS = ["loc", "cognitive_sum", "churn_30d", "function_count"];

export function overviewMetrics(catalogue: readonly MetricDescriptor[]): MetricDescriptor[] {
  return OVERVIEW_METRICS.flatMap((name) => catalogue.filter((m) => m.name === name));
}
