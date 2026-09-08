import type {
  FileFingerprint,
  GraphEdge,
  GraphMetric,
  GraphNode,
  IdAlias,
  IdAliasReason,
  SnapshotRow,
} from "./types.js";

// Raw row shapes as stored in SQLite, paired with mappers to the domain types.
// Kept separate from the connection/statement manager in database.ts.

export interface SnapshotDbRow {
  id: number;
  ref: string;
  commit_hash: string | null;
  taken_at: string;
  index_version: string;
  attrs: string;
}

export interface NodeDbRow {
  id: string;
  kind: string;
  name: string;
  parent_id: string | null;
  language: string | null;
  role: string | null;
  attrs: string;
}

export interface EdgeDbRow {
  src_id: string;
  dst_id: string;
  kind: string;
  attrs: string;
}

export interface MetricDbRow {
  node_id: string;
  name: string;
  value: number | null;
  unit: string | null;
}

export interface AliasDbRow {
  old_id: string;
  new_id: string;
  reason: string;
}

export interface FingerprintDbRow {
  file_id: string;
  content_hash: string;
  structural_hash: string | null;
}

export function rowToSnapshot(row: SnapshotDbRow): SnapshotRow {
  return {
    id: row.id,
    ref: row.ref,
    commitHash: row.commit_hash,
    takenAt: row.taken_at,
    indexVersion: row.index_version,
    attrs: JSON.parse(row.attrs) as Record<string, unknown>,
  };
}

export function rowToNode(row: NodeDbRow): GraphNode {
  return {
    id: row.id,
    kind: row.kind as GraphNode["kind"],
    name: row.name,
    parentId: row.parent_id ?? undefined,
    language: row.language ?? undefined,
    role: (row.role ?? undefined) as GraphNode["role"],
    attrs: JSON.parse(row.attrs) as Record<string, unknown>,
  };
}

export function rowToEdge(row: EdgeDbRow): GraphEdge {
  return {
    srcId: row.src_id,
    dstId: row.dst_id,
    kind: row.kind as GraphEdge["kind"],
    attrs: JSON.parse(row.attrs) as Record<string, unknown>,
  };
}

export function rowToMetric(row: MetricDbRow): GraphMetric {
  return {
    nodeId: row.node_id,
    name: row.name,
    value: row.value,
    unit: row.unit ?? undefined,
  };
}

export function rowToAlias(row: AliasDbRow): IdAlias {
  return {
    oldId: row.old_id,
    newId: row.new_id,
    reason: row.reason as IdAliasReason,
  };
}

export function rowToFingerprint(row: FingerprintDbRow): FileFingerprint {
  return {
    fileId: row.file_id,
    contentHash: row.content_hash,
    structuralHash: row.structural_hash ?? undefined,
  };
}
