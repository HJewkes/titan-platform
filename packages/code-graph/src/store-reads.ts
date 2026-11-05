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

interface AllStatement<P extends unknown[], R> {
  readonly source: string;
  all(...params: P): R[];
}

/** One node's value for one metric, joined to the node's own vocabulary columns. */
export interface TopMetricRow {
  nodeId: string;
  name: string;
  kind: string;
  role: string | null;
  value: number | null;
  unit: string | null;
}

interface TopMetricDbRow {
  node_id: string;
  value: number | null;
  unit: string | null;
  kind: string;
  name: string;
  role: string | null;
}

export interface TargetedStatements {
  listMetricsForNode: AllStatement<[snapshotId: number, nodeId: string], MetricDbRow>;
  listEdgesTouching: AllStatement<[{ snapshotId: number; nodeId: string }], EdgeDbRow>;
  aggregateMetric: AllStatement<[snapshotId: number, name: string], AggregateDbRow>;
  aggregateMetrics: AllStatement<[snapshotId: number], AggregateDbRow>;
  listMetricNames: AllStatement<[snapshotId: number], { name: string }>;
  topByMetric: AllStatement<[snapshotId: number, metric: string, limit: number], TopMetricDbRow>;
  topByMetricOfKind: AllStatement<[snapshotId: number, metric: string, kind: string, limit: number], TopMetricDbRow>;
}

const EDGE_COLS = "src_id, dst_id, kind, attrs";
// CROSS JOIN pins metric as the outer loop; unanalyzed, SQLite otherwise probes metric once per node.
const AGGREGATE_SELECT = `SELECT m.name AS name, n.kind AS node_kind, COUNT(m.value) AS count,
  SUM(m.value) AS sum, MIN(m.value) AS min, MAX(m.value) AS max
  FROM metric m CROSS JOIN node n ON n.snapshot_id = m.snapshot_id AND n.id = m.node_id`;
const TOP_SELECT = `SELECT m.node_id, m.value, m.unit, n.kind, n.name, n.role
  FROM metric m JOIN node n ON n.snapshot_id = m.snapshot_id AND n.id = m.node_id
  WHERE m.snapshot_id = ? AND m.name = ?`;
const TOP_ORDER = "ORDER BY m.value DESC LIMIT ?";

/** Reads that touch one node or one metric instead of a whole snapshot; each is an index search. */
export function prepareTargetedStatements(db: Db): TargetedStatements {
  return {
    listMetricsForNode: db.prepare<[number, string], MetricDbRow>(
      "SELECT node_id, name, value, unit FROM metric WHERE snapshot_id = ? AND node_id = ?",
    ),
    // The second arm skips self-loops so an edge from a node to itself comes back once.
    listEdgesTouching: db.prepare<[{ snapshotId: number; nodeId: string }], EdgeDbRow>(
      `SELECT ${EDGE_COLS} FROM edge WHERE snapshot_id = @snapshotId AND src_id = @nodeId
       UNION ALL
       SELECT ${EDGE_COLS} FROM edge WHERE snapshot_id = @snapshotId AND dst_id = @nodeId AND src_id <> @nodeId`,
    ),
    aggregateMetric: db.prepare<[number, string], AggregateDbRow>(
      `${AGGREGATE_SELECT} WHERE m.snapshot_id = ? AND m.name = ? GROUP BY n.kind ORDER BY n.kind`,
    ),
    aggregateMetrics: db.prepare<[number], AggregateDbRow>(
      `${AGGREGATE_SELECT} WHERE m.snapshot_id = ? GROUP BY m.name, n.kind ORDER BY m.name, n.kind`,
    ),
    listMetricNames: db.prepare<[number], { name: string }>("SELECT DISTINCT name FROM metric WHERE snapshot_id = ? ORDER BY name"),
    topByMetric: db.prepare<[number, string, number], TopMetricDbRow>(`${TOP_SELECT} ${TOP_ORDER}`),
    topByMetricOfKind: db.prepare<[number, string, string, number], TopMetricDbRow>(`${TOP_SELECT} AND n.kind = ? ${TOP_ORDER}`),
  };
}

export function readMetricsForNode(stmts: TargetedStatements, snapshotId: number, nodeId: string): GraphMetric[] {
  return stmts.listMetricsForNode.all(snapshotId, nodeId).map(rowToMetric);
}

export function readEdgesTouching(stmts: TargetedStatements, snapshotId: number, nodeId: string): GraphEdge[] {
  return stmts.listEdgesTouching.all({ snapshotId, nodeId }).map(rowToEdge);
}

export function readMetricNames(stmts: TargetedStatements, snapshotId: number): string[] {
  return stmts.listMetricNames.all(snapshotId).map((r) => r.name);
}

export function readTopByMetric(
  stmts: TargetedStatements,
  opts: { snapshotId: number; metric: string; limit?: number; kind?: string },
): TopMetricRow[] {
  const limit = opts.limit ?? 20;
  const rows =
    opts.kind === undefined
      ? stmts.topByMetric.all(opts.snapshotId, opts.metric, limit)
      : stmts.topByMetricOfKind.all(opts.snapshotId, opts.metric, opts.kind, limit);
  return rows.map((r) => ({
    nodeId: r.node_id,
    name: r.name,
    kind: r.kind,
    role: r.role,
    value: r.value,
    unit: r.unit,
  }));
}

export function readMetricAggregates(stmts: TargetedStatements, snapshotId: number, name?: string): MetricAggregate[] {
  const rows = name === undefined ? stmts.aggregateMetrics.all(snapshotId) : stmts.aggregateMetric.all(snapshotId, name);
  return rows.map((r) => ({
    name: r.name,
    nodeKind: r.node_kind as NodeKind,
    count: r.count,
    sum: r.sum,
    min: r.min,
    max: r.max,
  }));
}
