import type { ParsedFile } from "@titan-design/code-parser";
import { computeMetrics } from "./metrics.js";
import { computeSourceMetrics } from "./source-metrics.js";
import { computeDeadCodeMetrics } from "./analysis/dead-code.js";
import { computeCallMetrics } from "./analysis/call-metrics.js";
import { computeGrowthRiskMetrics } from "./analysis/growth-risk.js";
import { fileId } from "./extractors/ids.js";
import { linkTestsToSources, testCoverageCountMetrics } from "./analysis/test-linker.js";
import { computeTestKindMetrics } from "./analysis/test-kinds.js";
import { computeChangeCoupling, type ChurnEntry } from "./history/index.js";
import {
  collectFileIds,
  computeTestCoverageOwnership,
  loadHistoryMetrics,
  type HistoryMetricsOptions,
} from "./history-metrics.js";
import type { FileDigest } from "./file-digest.js";
import type { GraphEdge, GraphMetric, GraphNode } from "./types.js";

export interface IndexerMetricsInput {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  /** Files (re)parsed this run — source metrics are computed fresh for these. */
  parsedFiles?: ParsedFile[];
  /**
   * Digests of the files (re)parsed this run, used in place of `parsedFiles` so
   * their trees can be deleted before metrics run (TP-747).
   */
  fileDigests?: readonly FileDigest[];
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
  const fresh = input.fileDigests ? metricsFromDigests(input.fileDigests, input.nodes) : metricsFromParsed(input, nodeList);
  const sourceMetrics = [...fresh.source, ...input.reusedSourceMetrics];
  const metrics = [
    ...computeMetrics(nodeList, edgeList),
    ...computeCallMetrics(nodeList, edgeList),
    ...sourceMetrics,
    ...fresh.deadCode,
    ...fresh.growthRisk,
    ...(history?.metrics ?? []),
    ...computeTestCoverage(nodeList, history?.primaryEntries ?? null, input.history?.churnWindowDays),
    ...computeTestKindMetrics({ edges: edgeList, sourceMetrics, entryPoints: input.entryPoints }),
  ];
  return { metrics, warnings: history?.warnings ?? [] };
}

interface FreshFileMetrics {
  source: GraphMetric[];
  deadCode: GraphMetric[];
  growthRisk: GraphMetric[];
}

function metricsFromParsed(input: IndexerMetricsInput, nodeList: readonly GraphNode[]): FreshFileMetrics {
  const files = input.parsedFiles ?? [];
  const idOf = (p: string) => fileId(input.idRoot, p);
  return {
    source: computeSourceMetrics(files, idOf, symbolNamesByFile(nodeList)),
    deadCode: computeDeadCodeMetrics(files, idOf),
    growthRisk: computeGrowthRiskMetrics(files, idOf),
  };
}

/**
 * A digest carries symbol metrics for every symbol its file extracted; keep
 * only those whose node survived merge and pruning, which is the set the
 * parsed-file path derives from the final nodes.
 */
function metricsFromDigests(digests: readonly FileDigest[], nodes: ReadonlyMap<string, GraphNode>): FreshFileMetrics {
  const kept = (d: FileDigest) => d.sourceMetrics.filter((m) => m.nodeId === d.fileId || nodes.has(m.nodeId));
  return {
    source: digests.flatMap(kept),
    deadCode: digests.flatMap((d) => d.deadCodeMetrics),
    growthRisk: digests.flatMap((d) => d.growthRiskMetrics),
  };
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
