import type { GraphEdge, GraphNode, IdAliasReason } from "../types.js";

export interface MetricDelta {
  nodeId: string;
  name: string;
  before: number | null;
  after: number | null;
  delta: number | null;
}

export interface NodeRename {
  oldId: string;
  newId: string;
  reason: IdAliasReason;
  node: GraphNode;
}

export interface GraphDiffSummary {
  fromSnapshotId: number;
  toSnapshotId: number;
  addedNodes: number;
  removedNodes: number;
  renamedNodes: number;
  unchangedNodes: number;
  addedEdges: number;
  removedEdges: number;
  metricChanges: number;
}

export interface GraphDiff {
  summary: GraphDiffSummary;
  addedNodes: GraphNode[];
  removedNodes: GraphNode[];
  renamedNodes: NodeRename[];
  addedEdges: GraphEdge[];
  removedEdges: GraphEdge[];
  metricDeltas: MetricDelta[];
}
