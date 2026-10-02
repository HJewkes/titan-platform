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

/** Why a symbol present in both snapshots changed; `renamed` alone means its footprint held. */
export type FootprintChangeReason = "signature" | "consumers" | "coupling" | "renamed";

export interface FootprintChange {
  /** The to-snapshot id; a removed symbol keeps its from-snapshot id. */
  symbolId: string;
  /** The from-snapshot id, set only when it differs from `symbolId`. */
  previousId?: string;
  status: "added" | "removed" | "changed";
  /** Empty for an added or removed symbol. */
  reasons: FootprintChangeReason[];
  /** The declaring file, in the to-snapshot's id space where it still exists there. */
  fileId: string;
}

export interface FootprintDiff {
  fromSnapshotId: number;
  toSnapshotId: number;
  /** Sorted by `symbolId`; an unchanged symbol is absent. */
  changes: FootprintChange[];
  /** Sorted distinct declaring files of `changes`; consumer files never appear here. */
  files: string[];
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
