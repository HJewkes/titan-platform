import type { ParsedFile } from "@titan-design/code-parser";
import { computeMetrics } from "./metrics.js";
import { computeSourceMetrics } from "./source-metrics.js";
import { computeDeadCodeMetrics } from "./analysis/dead-code.js";
import { computeGrowthRiskMetrics } from "./analysis/growth-risk.js";
import { fileId } from "./extractors/ids.js";
import { buildHistoryMetrics, type HistoryMetricsOptions } from "./history-metrics.js";
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
 * the `history-metrics.ts` adapter; test-coverage metrics are not ported yet.
 */
export function buildIndexerMetrics(input: IndexerMetricsInput): GraphMetric[] {
  const nodeList = [...input.nodes.values()];
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
    ...(input.history ? buildHistoryMetrics(nodeList, input.idRoot, input.history) : []),
  ];
}
