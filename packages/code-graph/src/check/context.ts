import type { CodeGraphStore } from "../store.js";
import type { GraphEdge, GraphMetric, GraphNode } from "../types.js";

/** The three whole-snapshot reads rule evaluation needs; any store with them can be checked. */
export type RuleStore = Pick<CodeGraphStore, "listNodes" | "listEdges" | "listMetrics">;

export interface RuleContext {
  nodes: readonly GraphNode[];
  /** Kept apart from `nodes` so only rules that ask for `kind: "symbol"` evaluate them. */
  symbolNodes: readonly GraphNode[];
  nodesById: Map<string, GraphNode>;
  metricsByNode: Map<string, Map<string, number>>;
  edges: readonly GraphEdge[];
}

/** The snapshot's file-level graph (no references edges), its symbol layer, and its non-null metrics. */
export function buildRuleContext(store: RuleStore, snapshotId: number): RuleContext {
  const all = store.listNodes(snapshotId, { includeSymbols: true });
  const nodes = all.filter((n) => n.kind !== "symbol");
  const symbolNodes = all.filter((n) => n.kind === "symbol");
  const edges = store.listEdges(snapshotId);
  const nodesById = new Map<string, GraphNode>();
  for (const n of nodes) nodesById.set(n.id, n);
  return { nodes, symbolNodes, nodesById, metricsByNode: indexMetrics(store.listMetrics(snapshotId)), edges };
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
