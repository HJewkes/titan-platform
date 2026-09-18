import type { ParsedFile } from "@titan-design/code-parser";
import { computeMetrics } from "./metrics.js";
import { computeSourceMetrics } from "./source-metrics.js";
import { computeDeadCodeMetrics } from "./analysis/dead-code.js";
import { computeGrowthRiskMetrics } from "./analysis/growth-risk.js";
import { fileId } from "./extractors/ids.js";
import { linkTestsToSources, testCoverageCountMetrics } from "./analysis/test-linker.js";
import { computeChangeCoupling, type ChurnEntry } from "./history/index.js";
import {
  collectFileIds,
  computeTestCoverageOwnership,
  loadHistoryMetrics,
  type HistoryMetricsOptions,
} from "./history-metrics.js";
import type { GraphEdge, GraphMetric, GraphNode } from "./types.js";

export interface IndexerMetricsInput {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  /** Files (re)parsed this run — source metrics are computed fresh for these. */
  parsedFiles: ParsedFile[];
  /** Source metrics carried forward verbatim for reused (unchanged) files. */
  reusedSourceMetrics: GraphMetric[];
  idRoot: string;
  /** Git-history metrics (churn, recency, ownership); omitted means none. */
  history?: HistoryMetricsOptions;
}

/**
 * Map each file id to the names of the `symbol` nodes it declares, so
 * `computeSourceMetrics` can attach per-function complexity. Reflects the
 * assembled node set (parsed + reused symbol nodes alike), so per-symbol
 * complexity is emitted for exactly the names that have a symbol node.
 */
function symbolNamesByFile(nodes: Iterable<GraphNode>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const n of nodes) {
    if (n.kind !== "symbol" || !n.parentId) continue;
    const bucket = out.get(n.parentId);
    if (bucket) bucket.add(n.name);
    else out.set(n.parentId, new Set([n.name]));
  }
  return out;
}

/**
 * Assemble the metric set for a snapshot: graph-wide degree metrics over the
 * full node/edge set, freshly-computed source metrics for (re)parsed files, and
 * reused source metrics carried forward for unchanged files. Everything but the
 * reused source metrics is recomputed over the full set, so the result matches a
 * full index regardless of how much was reused.
 *
 * Git-history metrics come from the path-based engine in `./history/` through
 * the `history-metrics.ts` adapter. Test-coverage metrics run with or without it.
 */
export function buildIndexerMetrics(input: IndexerMetricsInput): GraphMetric[] {
  const nodeList = [...input.nodes.values()];
  const history = input.history ? loadHistoryMetrics(nodeList, input.idRoot, input.history) : null;
  return [
    ...computeMetrics(nodeList, [...input.edges.values()]),
    ...computeSourceMetrics(
      input.parsedFiles,
      (p) => fileId(input.idRoot, p),
      symbolNamesByFile(nodeList),
    ),
    ...computeDeadCodeMetrics(input.parsedFiles, (p) => fileId(input.idRoot, p)),
    ...computeGrowthRiskMetrics(input.parsedFiles, (p) => fileId(input.idRoot, p)),
    ...input.reusedSourceMetrics,
    ...(history?.metrics ?? []),
    ...computeTestCoverage(nodeList, history?.primaryEntries ?? null, input.history?.churnWindowDays),
  ];
}

/**
 * Two-pass test↔source linker outputs: per-source coverage counts (always) and,
 * when churn is available, the bus-factor / top-author-share of each source's
 * test coverage. Path-convention links need no churn; co-edit supplementation
 * and the ownership split reuse the already-loaded churn entries.
 */
function computeTestCoverage(
  nodes: readonly GraphNode[],
  entries: readonly ChurnEntry[] | null,
  windowDays: number | undefined,
): GraphMetric[] {
  const coEditPairs = entries ? computeChangeCoupling(entries, { knownPaths: collectFileIds(nodes) }).pairs : [];
  const links = linkTestsToSources(nodes, coEditPairs);
  if (links.length === 0) return [];
  const out = testCoverageCountMetrics(links);
  if (entries) {
    out.push(...computeTestCoverageOwnership(entries, links, { windowDays }));
  }
  return out;
}
