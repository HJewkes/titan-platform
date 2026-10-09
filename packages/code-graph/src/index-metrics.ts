import type { ParsedFile } from "@titan-design/code-parser";
import { computeMetrics } from "./metrics.js";
import { computeSourceMetrics } from "./source-metrics.js";
import { computeDeadCodeMetrics } from "./analysis/dead-code.js";
import { computeCallMetrics } from "./analysis/call-metrics.js";
import { computeGrowthRiskMetrics } from "./analysis/growth-risk.js";
import { fileId } from "./extractors/ids.js";
import { linkTestsToSources, testCoverageCountMetrics, type TestSourceLink } from "./analysis/test-linker.js";
import { computeTestKindMetrics } from "./analysis/test-kinds.js";
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
  /** Python console-script targets (`pkg.cli:main`) that make their function an output boundary. */
  entryPoints?: readonly string[];
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
  return assembleIndexerMetrics(input).metrics;
}

export interface AssembledIndexerMetrics {
  metrics: GraphMetric[];
  /** Why git-history metrics are missing or partial; empty when history loaded or the root is not git. */
  warnings: readonly string[];
}

/** {@link buildIndexerMetrics} plus the history warnings it would otherwise drop. */
export function assembleIndexerMetrics(input: IndexerMetricsInput): AssembledIndexerMetrics {
  const nodeList = [...input.nodes.values()];
  const edgeList = [...input.edges.values()];
  const history = input.history ? loadHistoryMetrics(nodeList, input.idRoot, input.history) : null;
  const entries = history?.primaryEntries ?? null;
  const links = linkTests(nodeList, entries);
  const sourceMetrics = [
    ...computeSourceMetrics(input.parsedFiles, (p) => fileId(input.idRoot, p), symbolNamesByFile(nodeList)),
    ...input.reusedSourceMetrics,
  ];
  const metrics = [
    ...computeMetrics(nodeList, edgeList),
    ...computeCallMetrics(nodeList, edgeList),
    ...sourceMetrics,
    ...computeDeadCodeMetrics(input.parsedFiles, (p) => fileId(input.idRoot, p)),
    ...computeGrowthRiskMetrics(input.parsedFiles, (p) => fileId(input.idRoot, p)),
    ...(history?.metrics ?? []),
    ...computeTestCoverage(links, entries, input.history?.churnWindowDays),
    ...computeTestKindMetrics({ edges: edgeList, sourceMetrics, links, entryPoints: input.entryPoints }),
  ];
  return { metrics, warnings: history?.warnings ?? [] };
}

/** Path-convention links need no churn; co-edit supplementation reuses the already-loaded churn entries. */
function linkTests(nodes: readonly GraphNode[], entries: readonly ChurnEntry[] | null): TestSourceLink[] {
  const coEditPairs = entries ? computeChangeCoupling(entries, { knownPaths: collectFileIds(nodes) }).pairs : [];
  return linkTestsToSources(nodes, coEditPairs);
}

/**
 * Two-pass test↔source linker outputs: per-source coverage counts (always) and,
 * when churn is available, the bus-factor / top-author-share of each source's
 * test coverage.
 */
function computeTestCoverage(
  links: readonly TestSourceLink[],
  entries: readonly ChurnEntry[] | null,
  windowDays: number | undefined,
): GraphMetric[] {
  if (links.length === 0) return [];
  const out = testCoverageCountMetrics(links);
  if (entries) {
    out.push(...computeTestCoverageOwnership(entries, links, { windowDays }));
  }
  return out;
}
