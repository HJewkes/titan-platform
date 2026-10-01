import { existsSync, readFileSync } from "node:fs";
import { EXIT } from "@titan-design/registry";
import { parseBrokerLog, type BrokerEntry, type LastEventRecord, type SpawnRecord } from "@titan-design/session-analytics";
import { withEventsDb } from "./blocked-flow-sources.js";

/** Every entry of agent-chat's broker log, read once and never opened for writing. */
export function readBrokerLog(file: string): BrokerEntry[] {
  if (!existsSync(file)) throw Object.assign(new Error(`agent-chat broker log not found: ${file} (set TITAN_MINER_BROKER_LOG or pass --broker-log)`), { code: EXIT.DATAERR });
  return parseBrokerLog(readFileSync(file, "utf8").split("\n"));
}

const metaField = (key: string, column = "meta") => `CASE WHEN json_valid(${column}) THEN json_extract(${column}, '$.${key}') END`;

/** Each `agent_spawned` row's agent id, name and profile. */
export function readSpawns(eventsDb: string): SpawnRecord[] {
  const sql = `SELECT id AS eventId, msg_id AS agentId, coalesce(target, '') AS name, ${metaField("profile")} AS profile FROM events WHERE kind = 'agent_spawned' AND msg_id IS NOT NULL ORDER BY id`;
  return withEventsDb(eventsDb, (db) => db.prepare(sql).all() as SpawnRecord[]);
}

interface LastEventRow {
  eventId: number;
  ts: number;
  actor: string;
  kind: string;
  tool: string | null;
  resolutionEventId: number | null;
  endEventId: number | null;
}

/** Each actor's newest event before asOf other than a resolution, kept only where it is an approval request, with any resolution of it and any later exit or retirement. */
export function readLastPrompts(eventsDb: string, asOf: string): LastEventRecord[] {
  const sql = `SELECT e.id AS eventId, e.ts, e.actor, e.kind, ${metaField("tool_name", "e.meta")} AS tool,
      (SELECT min(r.id) FROM events r WHERE r.kind = 'resolution' AND r.ref = e.msg_id AND r.ts < @asOf) AS resolutionEventId,
      (SELECT min(x.id) FROM events x WHERE x.id > e.id AND x.ts < @asOf
        AND ((x.kind = 'agent_exited' AND x.actor = e.actor) OR (x.kind = 'agent_retired' AND x.target = e.actor))) AS endEventId
    FROM events e JOIN (SELECT actor, max(id) AS id FROM events WHERE ts < @asOf AND kind != 'resolution' GROUP BY actor) last ON e.id = last.id
    WHERE e.kind = 'approval_request' ORDER BY e.id`;
  const rows = withEventsDb(eventsDb, (db) => db.prepare(sql).all({ asOf: Date.parse(asOf) }) as LastEventRow[]);
  return rows.map(({ ts, ...row }) => ({ ...row, at: new Date(ts).toISOString() }));
}
