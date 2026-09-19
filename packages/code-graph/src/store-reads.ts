import type { Db } from "@titan-design/store-sqlite";
import { rowToEdge, rowToMetric, type EdgeDbRow, type MetricDbRow } from "./rows.js";
import type { GraphEdge, GraphMetric, NodeKind } from "./types.js";

/** One metric's values over the nodes of one kind in one snapshot; `count` excludes null values. */
export interface MetricAggregate {
  name: string;
  nodeKind: NodeKind;
  count: number;
  sum: number | null;
  min: number | null;
  max: number | null;
}

interface AggregateDbRow {
  name: string;
  node_kind: string;
  count: number;
  sum: number | null;
  min: number | null;
  max: number | null;
}

interface AllStatement<P extends unknown[]> {
  all(...params: P): unknown[];
}

export interface TargetedStatements {
  listMetricsForNode: AllStatement<[snapshotId: number, nodeId: string]>;
  listEdgesTouching: AllStatement<[{ snapshotId: number; nodeId: string }]>;
  aggregateMetric: AllStatement<[snapshotId: number, name: string]>;
  aggregateMetrics: AllStatement<[snapshotId: number]>;
}

const EDGE_COLS = "src_id, dst_id, kind, attrs";
// CROSS JOIN pins metric as the outer loop; unanalyzed, SQLite otherwise probes metric once per node.
const AGGREGATE_SELECT = `SELECT m.name AS name, n.kind AS node_kind, COUNT(m.value) AS count,
  SUM(m.value) AS sum, MIN(m.value) AS min, MAX(m.value) AS max
  FROM metric m CROSS JOIN node n ON n.snapshot_id = m.snapshot_id AND n.id = m.node_id`;

/** Reads that touch one node or one metric instead of a whole snapshot; each is an index search. */
export function prepareTargetedStatements(db: Db): TargetedStatements {
  return {
    listMetricsForNode: db.prepare(
      "SELECT node_id, name, value, unit FROM metric WHERE snapshot_id = ? AND node_id = ?",
    ),
    // The second arm skips self-loops so an edge from a node to itself comes back once.
    listEdgesTouching: db.prepare(
      `SELECT ${EDGE_COLS} FROM edge WHERE snapshot_id = @snapshotId AND src_id = @nodeId
       UNION ALL
       SELECT ${EDGE_COLS} FROM edge WHERE snapshot_id = @snapshotId AND dst_id = @nodeId AND src_id <> @nodeId`,
    ),
    aggregateMetric: db.prepare(
      `${AGGREGATE_SELECT} WHERE m.snapshot_id = ? AND m.name = ? GROUP BY n.kind ORDER BY n.kind`,
    ),
    aggregateMetrics: db.prepare(
      `${AGGREGATE_SELECT} WHERE m.snapshot_id = ? GROUP BY m.name, n.kind ORDER BY m.name, n.kind`,
    ),
  };
}

export function readMetricsForNode(stmts: TargetedStatements, snapshotId: number, nodeId: string): GraphMetric[] {
  return (stmts.listMetricsForNode.all(snapshotId, nodeId) as MetricDbRow[]).map(rowToMetric);
}

export function readEdgesTouching(stmts: TargetedStatements, snapshotId: number, nodeId: string): GraphEdge[] {
  return (stmts.listEdgesTouching.all({ snapshotId, nodeId }) as EdgeDbRow[]).map(rowToEdge);
}

export function readMetricAggregates(stmts: TargetedStatements, snapshotId: number, name?: string): MetricAggregate[] {
  const rows = (
    name === undefined ? stmts.aggregateMetrics.all(snapshotId) : stmts.aggregateMetric.all(snapshotId, name)
  ) as AggregateDbRow[];
  return rows.map((r) => ({
    name: r.name,
    nodeKind: r.node_kind as NodeKind,
    count: r.count,
    sum: r.sum,
    min: r.min,
    max: r.max,
  }));
}
