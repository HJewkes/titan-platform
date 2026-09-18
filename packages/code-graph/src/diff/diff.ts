import { canonicalEdgeKind, canonicalMetricName } from "../aliases.js";
import type { CodeGraphStore } from "../store.js";
import type { GraphEdge, GraphMetric, GraphNode, IdAlias } from "../types.js";
import type { GraphDiff, GraphDiffSummary, MetricDelta, NodeRename } from "./types.js";

type AliasMap = Map<string, IdAlias>;

function aliasMap(aliases: readonly IdAlias[]): AliasMap {
  const m = new Map<string, IdAlias>();
  for (const a of aliases) m.set(a.oldId, a);
  return m;
}

function resolveId(id: string, aliases: AliasMap): string {
  return aliases.get(id)?.newId ?? id;
}

function edgeKey(srcId: string, dstId: string, kind: string): string {
  return JSON.stringify([srcId, dstId, canonicalEdgeKind(kind)]);
}

function metricKey(nodeId: string, name: string): string {
  return JSON.stringify([nodeId, canonicalMetricName(name)]);
}

function indexEdges(edges: readonly GraphEdge[]): Map<string, GraphEdge> {
  const m = new Map<string, GraphEdge>();
  for (const e of edges) m.set(edgeKey(e.srcId, e.dstId, e.kind), e);
  return m;
}

interface NodeDiff {
  added: GraphNode[];
  removed: GraphNode[];
  renamed: NodeRename[];
  commonNewIds: Set<string>;
}

function diffNodes(fromNodes: readonly GraphNode[], toNodes: readonly GraphNode[], aliases: AliasMap): NodeDiff {
  const toIndex = new Map(toNodes.map((n) => [n.id, n]));
  const matchedToIds = new Set<string>();
  const removed: GraphNode[] = [];
  const renamed: NodeRename[] = [];
  for (const fromNode of fromNodes) {
    const newId = resolveId(fromNode.id, aliases);
    const toNode = toIndex.get(newId);
    if (!toNode) {
      removed.push(fromNode);
      continue;
    }
    matchedToIds.add(newId);
    if (newId !== fromNode.id) {
      renamed.push({ oldId: fromNode.id, newId, reason: aliases.get(fromNode.id)!.reason, node: toNode });
    }
  }
  const added = toNodes.filter((toNode) => !matchedToIds.has(toNode.id));
  return { added, removed, renamed, commonNewIds: matchedToIds };
}

function diffEdges(
  fromEdges: readonly GraphEdge[],
  toEdges: readonly GraphEdge[],
  aliases: AliasMap,
): { added: GraphEdge[]; removed: GraphEdge[] } {
  const remappedKey = (e: GraphEdge) => edgeKey(resolveId(e.srcId, aliases), resolveId(e.dstId, aliases), e.kind);
  const fromKeys = new Set(fromEdges.map(remappedKey));
  const toIndex = indexEdges(toEdges);
  const added: GraphEdge[] = [];
  for (const [k, e] of toIndex) {
    if (!fromKeys.has(k)) added.push(e);
  }
  const removed = fromEdges.filter((e) => !toIndex.has(remappedKey(e)));
  return { added, removed };
}

interface IndexedMetric {
  metric: GraphMetric;
  nodeId: string;
}

function indexFromMetrics(metrics: readonly GraphMetric[], aliases: AliasMap): Map<string, IndexedMetric> {
  const fromIndex = new Map<string, IndexedMetric>();
  for (const m of metrics) {
    const newId = resolveId(m.nodeId, aliases);
    fromIndex.set(metricKey(newId, m.name), { metric: m, nodeId: newId });
  }
  return fromIndex;
}

function deltaOf(before: number | null, after: number | null): number | null {
  if (before === null || after === null) return null;
  return after - before;
}

function metricDelta(nodeId: string, name: string, before: number | null, after: number | null): MetricDelta {
  return { nodeId, name: canonicalMetricName(name), before, after, delta: deltaOf(before, after) };
}

/** Metric changes on nodes present in both snapshots; metrics on added or removed nodes are the node's news, not drift. */
function diffMetrics(
  fromMetrics: readonly GraphMetric[],
  toMetrics: readonly GraphMetric[],
  aliases: AliasMap,
  commonNewIds: Set<string>,
): MetricDelta[] {
  const fromIndex = indexFromMetrics(fromMetrics, aliases);
  const toIndex = new Map(toMetrics.map((m) => [metricKey(m.nodeId, m.name), m]));
  const out: MetricDelta[] = [];
  const seen = new Set<string>();
  for (const [key, { metric: before, nodeId }] of fromIndex) {
    if (!commonNewIds.has(nodeId)) continue;
    seen.add(key);
    const afterVal = toIndex.get(key)?.value ?? null;
    if (before.value !== afterVal) out.push(metricDelta(nodeId, before.name, before.value, afterVal));
  }
  for (const [key, after] of toIndex) {
    if (seen.has(key) || !commonNewIds.has(after.nodeId)) continue;
    out.push(metricDelta(after.nodeId, after.name, null, after.value));
  }
  return out;
}

export interface DiffSnapshotsOptions {
  fromSnapshotId: number;
  toSnapshotId: number;
}

/** Structural diff of two snapshots; the to-snapshot's id aliases carry renamed nodes across so a move is not a delete plus an add. */
export function diffSnapshots(store: CodeGraphStore, options: DiffSnapshotsOptions): GraphDiff {
  const { fromSnapshotId, toSnapshotId } = options;
  const aliases = aliasMap(store.listAliases(toSnapshotId));
  const nodeDiff = diffNodes(store.listNodes(fromSnapshotId), store.listNodes(toSnapshotId), aliases);
  const edgeDiff = diffEdges(store.listEdges(fromSnapshotId), store.listEdges(toSnapshotId), aliases);
  const metricDeltas = diffMetrics(
    store.listMetrics(fromSnapshotId),
    store.listMetrics(toSnapshotId),
    aliases,
    nodeDiff.commonNewIds,
  );
  return {
    summary: summarize(options, nodeDiff, edgeDiff, metricDeltas),
    addedNodes: nodeDiff.added,
    removedNodes: nodeDiff.removed,
    renamedNodes: nodeDiff.renamed,
    addedEdges: edgeDiff.added,
    removedEdges: edgeDiff.removed,
    metricDeltas,
  };
}

function summarize(
  { fromSnapshotId, toSnapshotId }: DiffSnapshotsOptions,
  nodeDiff: NodeDiff,
  edgeDiff: { added: GraphEdge[]; removed: GraphEdge[] },
  metricDeltas: readonly MetricDelta[],
): GraphDiffSummary {
  return {
    fromSnapshotId,
    toSnapshotId,
    addedNodes: nodeDiff.added.length,
    removedNodes: nodeDiff.removed.length,
    renamedNodes: nodeDiff.renamed.length,
    unchangedNodes: nodeDiff.commonNewIds.size - nodeDiff.renamed.length,
    addedEdges: edgeDiff.added.length,
    removedEdges: edgeDiff.removed.length,
    metricChanges: metricDeltas.length,
  };
}
