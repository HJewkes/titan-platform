import type { CodeGraphStore } from "../store.js";
import type { GraphEdge, GraphMetric, GraphNode } from "../types.js";

export interface RuleContext {
  nodes: readonly GraphNode[];
  nodesById: Map<string, GraphNode>;
  metricsByNode: Map<string, Map<string, number>>;
  edges: readonly GraphEdge[];
}

/** The snapshot's file-level graph (no symbol layer, no references edges) and its non-null metrics. */
export function buildRuleContext(store: CodeGraphStore, snapshotId: number): RuleContext {
  const nodes = store.listNodes(snapshotId);
  const edges = store.listEdges(snapshotId);
  const nodesById = new Map<string, GraphNode>();
  for (const n of nodes) nodesById.set(n.id, n);
  return { nodes, nodesById, metricsByNode: indexMetrics(store.listMetrics(snapshotId)), edges };
}

function indexMetrics(metrics: readonly GraphMetric[]): Map<string, Map<string, number>> {
  const metricsByNode = new Map<string, Map<string, number>>();
  for (const m of metrics) {
    if (m.value === null) continue;
    let inner = metricsByNode.get(m.nodeId);
    if (!inner) {
      inner = new Map();
      metricsByNode.set(m.nodeId, inner);
    }
    inner.set(m.name, m.value);
  }
  return metricsByNode;
}
