import { hasColumn } from "@titan-design/store-sqlite";
import { openReadOnly } from "./broker.js";

/** One `agent_spawned` row and what the lifecycle rows after it say about that run. */
export interface SpawnFact {
  name: string;
  spawnedBy: string;
  at: number;
  repo: string | null;
  branch: string | null;
  /** The task id without its initiative, as Shepherd's PR refs carry it. */
  task: string | null;
  /** False for a reviewer or other non-implementing role, whose task names a PR it did not write. */
  implementer: boolean;
  live: boolean;
  costUsd: number | null;
}

/** The columns of a lifecycle row this read needs, with its meta fields pulled out by SQLite instead of parsing every 8 KB meta. */
export interface LifecycleRow {
  kind: string;
  actor: string;
  target: string | null;
  ts: number;
  name: string | null;
  repo: string | null;
  branch: string | null;
  task: string | null;
  role: string | null;
  origin: string | null;
  cost: string | number | null;
}

const LIFECYCLE_KINDS = ["agent_spawned", "agent_exited", "agent_retired", "agent_resumed"] as const;
const COLUMNS = ["kind", "actor", "target", "ts", "meta"] as const;
const META_FIELDS = { name: "name", repo: "repo", branch: "branch", task: "task", role: "work_role", origin: "origin", cost: "cost_usd" } as const;

const fieldsSql = Object.entries(META_FIELDS)
  .map(([alias, key]) => `json_extract(m, '$.${key}') AS ${alias}`)
  .join(", ");
// The kind index narrows the scan to lifecycle rows; json_valid keeps one malformed meta from failing the whole read.
const LIFECYCLE_SQL = `WITH rows AS (SELECT id, kind, actor, target, ts, CASE WHEN json_valid(meta) THEN meta ELSE '{}' END AS m FROM events WHERE kind IN (${LIFECYCLE_KINDS.map((kind) => `'${kind}'`).join(", ")}) AND ts >= @since) SELECT kind, actor, target, ts, ${fieldsSql} FROM rows ORDER BY id`;

/** Lifecycle rows since `since`, oldest first; null when events.db is absent, will not open, or lacks a column this reads. */
export function readLifecycleRows(file: string, since: number): LifecycleRow[] | null {
  const db = openReadOnly(file);
  if (!db) return null;
  try {
    if (COLUMNS.some((column) => !hasColumn(db, "events", column))) return null;
    return db.prepare(LIFECYCLE_SQL).all({ since }) as LifecycleRow[];
  } finally {
    db.close();
  }
}

const bareTask = (task: string | null): string | null => (task === null || task === "" ? null : task.slice(task.indexOf("/") + 1));

function spawnOf(row: LifecycleRow): SpawnFact | null {
  const name = row.target ?? row.name;
  if (name === null || name === "" || row.origin === "adopted") return null;
  return {
    name, spawnedBy: row.actor, at: row.ts, repo: row.repo, branch: row.branch, task: bareTask(row.task),
    implementer: row.role === null || row.role === "implementer", live: true, costUsd: null,
  };
}

/** Retire and resume name their agent in `target`; an exit row is the agent's own. */
const subjectOf = (row: LifecycleRow): string => (row.kind === "agent_exited" ? row.actor : (row.target ?? row.actor));

/** One fact per spawn row; a later lifecycle row applies to the newest spawn of that name. */
export function foldSpawns(rows: readonly LifecycleRow[]): SpawnFact[] {
  const spawns: SpawnFact[] = [];
  const newest = new Map<string, SpawnFact>();
  for (const row of rows) {
    if (row.kind === "agent_spawned") {
      const spawn = spawnOf(row);
      if (!spawn) continue;
      // A respawn takes the name over, so the older run is no longer the live one.
      const previous = newest.get(spawn.name);
      if (previous) previous.live = false;
      spawns.push(spawn);
      newest.set(spawn.name, spawn);
      continue;
    }
    const spawn = newest.get(subjectOf(row));
    if (!spawn) continue;
    spawn.live = row.kind === "agent_resumed";
    const cost = Number(row.cost);
    if (row.kind === "agent_exited" && row.cost !== null && Number.isFinite(cost)) spawn.costUsd = cost;
  }
  return spawns;
}
