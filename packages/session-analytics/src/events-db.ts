import type { Db } from "@titan-design/store-sqlite";
import { parseVerdict, type VerdictRecord } from "./blocked-flow-merge.js";
import type { SpawnRecord } from "./liveness-exits.js";
import type { LastEventRecord } from "./liveness-prompts.js";

/** agent-chat's events table as these readers expect it, from agent-chat's src/broker/event-log.ts; a fixture creates it with this. */
export const EVENTS_TABLE_DDL = `CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL,
  target TEXT, msg_id TEXT, ref TEXT, body TEXT, meta TEXT)`;

/** A runnable sqlite3 command for `sql`, binding each `@name` parameter to an epoch-millisecond placeholder through `.parameter set`. */
export function eventsDbCommand(sql: string): string {
  const params = [...new Set(sql.match(/@\w+/g) ?? [])];
  const binds = params.map((p) => `".parameter set ${p} <${p.slice(1)} epoch ms>"`);
  return ["sqlite3 -readonly <events.db>", ...binds, `"${sql}"`].join(" ");
}

const metaField = (key: string, column = "meta") => `CASE WHEN json_valid(${column}) THEN json_extract(${column}, '$.${key}') END`;

export const VERDICTS_SQL = `SELECT id, ts, actor, target, body FROM events WHERE kind = 'message' AND body LIKE 'Verdict:%' AND ts >= @since AND ts < @until ORDER BY id`;

interface VerdictRow {
  id: number;
  ts: number;
  actor: string;
  target: string | null;
  body: string;
}

/** Verdict messages, and how many `Verdict:` messages parseVerdict refused; window bounds are ISO and inclusive-exclusive, and `seats` limits the refused count to verdicts sent to those seats. */
export function readVerdicts(db: Db, window: { since?: string; until?: string }, seats?: readonly string[]): { verdicts: VerdictRecord[]; unparsed: number } {
  const bounds = { since: window.since ? Date.parse(window.since) : 0, until: window.until ? Date.parse(window.until) : Number.MAX_SAFE_INTEGER };
  const rows = db.prepare(VERDICTS_SQL).all(bounds) as VerdictRow[];
  const verdicts = rows.flatMap((row) => {
    const parsed = parseVerdict(row.body);
    return parsed ? [{ ...parsed, eventId: row.id, at: new Date(row.ts).toISOString(), seat: row.target ?? "", reviewer: row.actor }] : [];
  });
  const inSeats = (row: VerdictRow) => !seats || seats.includes(row.target ?? "");
  const unparsed = rows.filter((row) => !parseVerdict(row.body) && inSeats(row)).length;
  return { verdicts, unparsed };
}

export const SPAWNS_SQL = `SELECT id AS eventId, msg_id AS agentId, coalesce(target, '') AS name, ${metaField("profile")} AS profile FROM events WHERE kind = 'agent_spawned' AND msg_id IS NOT NULL ORDER BY id`;

/** Each `agent_spawned` row's agent id, name and profile. */
export function readSpawns(db: Db): SpawnRecord[] {
  return db.prepare(SPAWNS_SQL).all() as SpawnRecord[];
}

export const LAST_PROMPTS_SQL = [
  `SELECT e.id AS eventId, e.ts, e.actor, e.kind, ${metaField("tool_name", "e.meta")} AS tool,`,
  `(SELECT min(r.id) FROM events r WHERE r.kind = 'resolution' AND r.ref = e.msg_id AND r.ts < @asOf) AS resolutionEventId,`,
  `(SELECT min(x.id) FROM events x WHERE x.id > e.id AND x.ts < @asOf`,
  `AND ((x.kind = 'agent_exited' AND x.actor = e.actor) OR (x.kind = 'agent_retired' AND x.target = e.actor))) AS endEventId`,
  `FROM events e JOIN (SELECT actor, max(id) AS id FROM events WHERE ts < @asOf AND kind != 'resolution' GROUP BY actor) last ON e.id = last.id`,
  `WHERE e.kind = 'approval_request' ORDER BY e.id`,
].join(" ");

interface LastEventRow extends Omit<LastEventRecord, "at"> {
  ts: number;
}

/** Each actor's newest event before asOf other than a resolution, kept only where it is an approval request, with any resolution of it and any later exit or retirement. */
export function readLastPrompts(db: Db, asOf: string): LastEventRecord[] {
  const rows = db.prepare(LAST_PROMPTS_SQL).all({ asOf: Date.parse(asOf) }) as LastEventRow[];
  return rows.map(({ ts, ...row }) => ({ ...row, at: new Date(ts).toISOString() }));
}
