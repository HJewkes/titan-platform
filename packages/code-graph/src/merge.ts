import type { GraphEdge, GraphFragment, GraphNode } from "./types.js";

export interface ExtractAccumulator {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
}

/**
 * JSON-encoded so ids containing the separator can't collide (paths may hold
 * spaces). Mirrors the `(snapshot_id, src_id, dst_id, kind)` edge primary key.
 */
function edgeKey(edge: GraphEdge): string {
  return JSON.stringify([edge.srcId, edge.dstId, edge.kind]);
}

/** First fragment wins per id, so walk order decides shared nodes exactly as a full index would. */
export function mergeFragments(fragments: readonly GraphFragment[]): ExtractAccumulator {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  for (const fragment of fragments) {
    for (const node of fragment.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
    for (const edge of fragment.edges) {
      const key = edgeKey(edge);
      if (!edges.has(key)) edges.set(key, edge);
    }
  }
  return { nodes, edges };
}
