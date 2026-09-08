import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { MIGRATIONS } from "./schema.js";
import {
  rowToAlias,
  rowToEdge,
  rowToFingerprint,
  rowToMetric,
  rowToNode,
  rowToSnapshot,
  type AliasDbRow,
  type EdgeDbRow,
  type FingerprintDbRow,
  type MetricDbRow,
  type NodeDbRow,
  type SnapshotDbRow,
} from "./rows.js";
import type {
  FileFingerprint,
  GraphEdge,
  GraphMetric,
  GraphNode,
  IdAlias,
  SnapshotRow,
} from "./types.js";

export interface SnapshotInsert {
  ref: string;
  commitHash?: string;
  indexVersion: string;
  attrs?: Record<string, unknown>;
}

const NODE_COLS = "id, kind, name, parent_id, language, role, attrs";

/**
 * The code graph's query surface over store-sqlite's snapshot-scoped kit tables
 * plus this package's domain tables. Replaces codewatch's `GraphDatabase`: the
 * connection, pragmas, and migration runner are the kit's; what is left here is
 * the code-specific statements the indexer and its readers need.
 */
export class CodeGraphStore {
  private readonly statements;

  constructor(readonly db: Db) {
    this.statements = prepareStatements(db);
  }

  createSnapshot(input: SnapshotInsert): number {
    const result = this.statements.insertSnapshot.run({
      ref: input.ref,
      commitHash: input.commitHash ?? null,
      indexVersion: input.indexVersion,
      attrs: JSON.stringify(input.attrs ?? {}),
    });
    return Number(result.lastInsertRowid);
  }

  insertNodes(snapshotId: number, nodes: readonly GraphNode[]): void {
    const stmt = this.statements.insertNode;
    this.db.transaction(() => {
      for (const n of nodes) {
        stmt.run({
          snapshotId,
          id: n.id,
          kind: n.kind,
          name: n.name,
          parentId: n.parentId ?? null,
          language: n.language ?? null,
          role: n.role ?? null,
          attrs: JSON.stringify(n.attrs ?? {}),
        });
      }
    })();
  }

  insertEdges(snapshotId: number, edges: readonly GraphEdge[]): void {
    const stmt = this.statements.insertEdge;
    this.db.transaction(() => {
      for (const e of edges) {
        stmt.run({
          snapshotId,
          srcId: e.srcId,
          dstId: e.dstId,
          kind: e.kind,
          attrs: JSON.stringify(e.attrs ?? {}),
        });
      }
    })();
  }

  insertMetrics(snapshotId: number, metrics: readonly GraphMetric[]): void {
    const stmt = this.statements.insertMetric;
    this.db.transaction(() => {
      for (const m of metrics) {
        stmt.run({ snapshotId, nodeId: m.nodeId, name: m.name, value: m.value, unit: m.unit ?? null });
      }
    })();
  }

  insertAliases(snapshotId: number, aliases: readonly IdAlias[]): void {
    const stmt = this.statements.insertAlias;
    this.db.transaction(() => {
      for (const a of aliases) {
        stmt.run({ snapshotId, oldId: a.oldId, newId: a.newId, reason: a.reason });
      }
    })();
  }

  insertFingerprints(snapshotId: number, fingerprints: readonly FileFingerprint[]): void {
    const stmt = this.statements.insertFingerprint;
    this.db.transaction(() => {
      for (const f of fingerprints) {
        stmt.run({
          snapshotId,
          fileId: f.fileId,
          contentHash: f.contentHash,
          structuralHash: f.structuralHash ?? null,
        });
      }
    })();
  }

  getSnapshot(id: number): SnapshotRow | null {
    const row = this.statements.getSnapshot.get(id) as SnapshotDbRow | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  listSnapshots(opts: { ref?: string; limit?: number } = {}): SnapshotRow[] {
    const limit = opts.limit ?? 50;
    const rows = (
      opts.ref
        ? this.statements.listSnapshotsByRef.all(opts.ref, limit)
        : this.statements.listSnapshots.all(limit)
    ) as SnapshotDbRow[];
    return rows.map(rowToSnapshot);
  }

  getLatestSnapshotByRef(ref: string): SnapshotRow | null {
    return this.listSnapshots({ ref, limit: 1 })[0] ?? null;
  }

  getNode(snapshotId: number, id: string): GraphNode | null {
    const row = this.statements.getNode.get(snapshotId, id) as NodeDbRow | undefined;
    return row ? rowToNode(row) : null;
  }

  /**
   * File-level structural graph by default: the per-symbol layer is excluded so
   * consumers that reason about module structure see the graph they expect. Pass
   * `includeSymbols` for the symbol layer (the reuse basis needs it).
   */
  listNodes(snapshotId: number, opts?: { includeSymbols?: boolean }): GraphNode[] {
    const nodes = (this.statements.listNodes.all(snapshotId) as NodeDbRow[]).map(rowToNode);
    return opts?.includeSymbols ? nodes : nodes.filter((n) => n.kind !== "symbol");
  }

  /** See {@link listNodes}: `references` edges are the symbol layer, excluded by default. */
  listEdges(snapshotId: number, opts?: { includeReferences?: boolean }): GraphEdge[] {
    const edges = (this.statements.listEdges.all(snapshotId) as EdgeDbRow[]).map(rowToEdge);
    return opts?.includeReferences ? edges : edges.filter((e) => e.kind !== "references");
  }

  listMetrics(snapshotId: number): GraphMetric[] {
    return (this.statements.listMetrics.all(snapshotId) as MetricDbRow[]).map(rowToMetric);
  }

  listAliases(snapshotId: number): IdAlias[] {
    return (this.statements.listAliases.all(snapshotId) as AliasDbRow[]).map(rowToAlias);
  }

  listFingerprints(snapshotId: number): FileFingerprint[] {
    return (this.statements.listFingerprints.all(snapshotId) as FingerprintDbRow[]).map(rowToFingerprint);
  }

  close(): void {
    this.db.close();
  }
}

function prepareStatements(db: Db) {
  return {
    insertSnapshot: db.prepare(
      `INSERT INTO snapshot (ref, commit_hash, index_version, attrs)
       VALUES (@ref, @commitHash, @indexVersion, @attrs)`,
    ),
    insertNode: db.prepare(
      `INSERT OR REPLACE INTO node (snapshot_id, id, kind, name, parent_id, language, role, attrs)
       VALUES (@snapshotId, @id, @kind, @name, @parentId, @language, @role, @attrs)`,
    ),
    insertEdge: db.prepare(
      `INSERT OR REPLACE INTO edge (snapshot_id, src_id, dst_id, kind, attrs)
       VALUES (@snapshotId, @srcId, @dstId, @kind, @attrs)`,
    ),
    insertMetric: db.prepare(
      `INSERT OR REPLACE INTO metric (snapshot_id, node_id, name, value, unit)
       VALUES (@snapshotId, @nodeId, @name, @value, @unit)`,
    ),
    insertAlias: db.prepare(
      `INSERT OR REPLACE INTO id_alias (snapshot_id, old_id, new_id, reason)
       VALUES (@snapshotId, @oldId, @newId, @reason)`,
    ),
    insertFingerprint: db.prepare(
      `INSERT OR REPLACE INTO file_fingerprint (snapshot_id, file_id, content_hash, structural_hash)
       VALUES (@snapshotId, @fileId, @contentHash, @structuralHash)`,
    ),
    getSnapshot: db.prepare("SELECT * FROM snapshot WHERE id = ?"),
    listSnapshots: db.prepare("SELECT * FROM snapshot ORDER BY taken_at DESC, id DESC LIMIT ?"),
    listSnapshotsByRef: db.prepare(
      "SELECT * FROM snapshot WHERE ref = ? ORDER BY taken_at DESC, id DESC LIMIT ?",
    ),
    getNode: db.prepare(`SELECT ${NODE_COLS} FROM node WHERE snapshot_id = ? AND id = ?`),
    listNodes: db.prepare(`SELECT ${NODE_COLS} FROM node WHERE snapshot_id = ?`),
    listEdges: db.prepare("SELECT src_id, dst_id, kind, attrs FROM edge WHERE snapshot_id = ?"),
    listMetrics: db.prepare("SELECT node_id, name, value, unit FROM metric WHERE snapshot_id = ?"),
    listAliases: db.prepare("SELECT old_id, new_id, reason FROM id_alias WHERE snapshot_id = ?"),
    listFingerprints: db.prepare(
      "SELECT file_id, content_hash, structural_hash FROM file_fingerprint WHERE snapshot_id = ?",
    ),
  };
}

/** Open (creating if absent) a code graph database and bring it to the current schema. */
export function openCodeGraph(dbPath: string): CodeGraphStore {
  const db = openDatabase(dbPath);
  runMigrations(db, MIGRATIONS);
  return new CodeGraphStore(db);
}
