export type NodeKind =
  | "package"
  | "module"
  | "file"
  | "symbol"
  | "external";

export type EdgeKind =
  | "imports"
  | "re-exports"
  | "calls"
  | "extends"
  | "implements"
  | "references"
  | "depends-on";

/** `requalify` maps a bare-name symbol id from before index version 0.14.0 to its scope-qualified successor. */
export type IdAliasReason = "rename" | "move" | "merge" | "requalify";

export type NodeRole =
  | "test"
  | "fixture"
  | "barrel"
  | "types"
  | "config"
  | "script"
  | "entry"
  | "generated"
  | "source";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  parentId?: string;
  language?: string;
  role?: NodeRole;
  attrs?: Record<string, unknown>;
}

export interface GraphEdge {
  srcId: string;
  dstId: string;
  kind: EdgeKind;
  attrs?: Record<string, unknown>;
}

export interface GraphMetric {
  nodeId: string;
  name: string;
  value: number | null;
  unit?: string;
}

export interface GraphFragment {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface SnapshotRow {
  id: number;
  ref: string;
  commitHash: string | null;
  takenAt: string;
  indexVersion: string;
  attrs: Record<string, unknown>;
}

export interface IdAlias {
  oldId: string;
  newId: string;
  reason: IdAliasReason;
}

export interface FileFingerprint {
  fileId: string;
  contentHash: string;
  /**
   * Comment/whitespace-insensitive parse-structure hash (C-18). Absent on
   * snapshots written before C-18 (they can only reuse whole unchanged files).
   */
  structuralHash?: string;
}

