import type { CodeGraphStore } from "./store.js";
import type { GraphEdge, GraphMetric, GraphNode } from "./types.js";

/**
 * The free-function reading surface named in the package API. Each delegates to
 * the store's method of the same name, so a caller that only reads a snapshot
 * never has to hold on to the store's shape.
 */
export function listNodes(
  store: CodeGraphStore,
  snapshotId: number,
  opts?: { includeSymbols?: boolean },
): GraphNode[] {
  return store.listNodes(snapshotId, opts);
}

export function listEdges(
  store: CodeGraphStore,
  snapshotId: number,
  opts?: { includeReferences?: boolean },
): GraphEdge[] {
  return store.listEdges(snapshotId, opts);
}

export function listMetrics(store: CodeGraphStore, snapshotId: number): GraphMetric[] {
  return store.listMetrics(snapshotId);
}
