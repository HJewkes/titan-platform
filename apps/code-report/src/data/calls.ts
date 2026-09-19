import type { CodeReadCommandMap, MetricDescriptor } from "@titan-design/code-read/query";
import { PAGE_SIZE } from "./page-size.js";

type Args<K extends keyof CodeReadCommandMap> = CodeReadCommandMap[K]["args"];

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
