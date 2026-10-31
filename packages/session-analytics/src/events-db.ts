import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
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
  const rows = db.prepare<[object], VerdictRow>(VERDICTS_SQL).all(bounds);
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
  return db.prepare<[], SpawnRecord>(SPAWNS_SQL).all();
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
  const rows = db.prepare<[object], LastEventRow>(LAST_PROMPTS_SQL).all({ asOf: Date.parse(asOf) });
  return rows.map(({ ts, ...row }) => ({ ...row, at: new Date(ts).toISOString() }));
}

/** A seat's handoff as agent-chat stores it: `actor` is the name the successor keeps, `ref` the outgoing agent id, `meta.successor` the incoming one. */
export interface HandoffRecord {
  eventId: number;
  at: string;
  seat: string;
  predecessorId: string;
  successorId: string | null;
  /** The predecessor stood down afterwards; an uncommitted handoff is a teleport that was aborted. */
  committed: boolean;
}

export const HANDOFFS_SQL = [
  `SELECT h.id AS eventId, h.ts, h.actor AS seat, h.ref AS predecessorId, ${metaField("successor", "h.meta")} AS successorId,`,
  `EXISTS (SELECT 1 FROM events s WHERE s.ref = h.ref AND s.kind = 'agent_stood_down' AND s.id > h.id) AS committed`,
  `FROM events h WHERE h.kind = 'agent_handoff' AND h.ref IS NOT NULL AND h.ts >= @since ORDER BY h.id`,
].join(" ");

const handoffRowsSchema = z.array(
  z.object({
    eventId: z.number(),
    ts: z.number(),
    seat: z.string(),
    predecessorId: z.string(),
    successorId: z.unknown().transform((value) => (typeof value === "string" ? value : null)),
    committed: z.number(),
  }),
);

/**
 * `agent_handoff` rows at or after `since` (ISO), oldest first. To resolve seat generations, omit
 * `since`: the generation live at a window's start began with a handoff written before it.
 */
export function readHandoffs(db: Db, since?: string): HandoffRecord[] {
  const rows = handoffRowsSchema.parse(db.prepare(HANDOFFS_SQL).all({ since: since ? Date.parse(since) : 0 }));
  return rows.map(({ ts, committed, ...row }) => ({ ...row, at: new Date(ts).toISOString(), committed: committed === 1 }));
}

/** A worker's report to its coordinator, with the worker's last spawn before it, when the log has one. */
export interface WorkerReportRecord {
  eventId: number;
  at: string;
  agent: string;
  coordinator: string;
  spawnedAt: string | null;
  body: string;
}

export const WORKER_REPORTS_SQL = [
  `SELECT m.id AS eventId, m.ts, m.actor AS agent, coalesce(m.target, '') AS coordinator, m.body,`,
  `(SELECT max(s.ts) FROM events s WHERE s.kind = 'agent_spawned' AND s.target = m.actor AND s.ts <= m.ts) AS spawnedTs`,
  `FROM events m WHERE m.kind = 'message' AND m.body LIKE 'Status:%' AND m.ts >= @since AND m.ts < @until ORDER BY m.id`,
].join(" ");

const workerReportRowsSchema = z.array(
  z.object({ eventId: z.number(), ts: z.number(), agent: z.string(), coordinator: z.string(), body: z.string(), spawnedTs: z.number().nullable() }),
);

/** Messages that open with the return contract's `Status:` line, inside the inclusive-exclusive ISO window. */
export function readWorkerReports(db: Db, window: { since: string; until: string }): WorkerReportRecord[] {
  const rows = workerReportRowsSchema.parse(db.prepare(WORKER_REPORTS_SQL).all({ since: Date.parse(window.since), until: Date.parse(window.until) }));
  return rows.map(({ ts, spawnedTs, ...row }) => ({ ...row, at: new Date(ts).toISOString(), spawnedAt: spawnedTs === null ? null : new Date(spawnedTs).toISOString() }));
}

/** A Claude session agent-chat started or resumed for a named agent; the session id names its transcript file. */
export interface WorkerSessionRecord {
  agent: string;
  sessionId: string;
}

/** Spawn and resume rows only, so the kind index carries it; coordinators are told apart in code, since a correlated subquery over a coordinator's events is slow. */
export const WORKER_SESSIONS_SQL = [
  `SELECT kind, actor, target AS agent, ${metaField("session_id")} AS sessionId, ${metaField("profile")} AS profile FROM events`,
  `WHERE kind IN ('agent_spawned', 'agent_resumed') AND target IS NOT NULL AND ts < @until ORDER BY id`,
].join(" ");

const sessionEventRowsSchema = z.array(
  z.object({ kind: z.string(), actor: z.string(), agent: z.string(), sessionId: z.unknown(), profile: z.unknown() }),
);

/**
 * Every worker session started or resumed before `until` (ISO), whichever window its transcript is
 * read for. A coordinator is left out, by its profile or by having spawned an agent itself: it idles
 * on its inbox by design, which is not friction.
 */
export function readWorkerSessions(db: Db, until: string): WorkerSessionRecord[] {
  const rows = sessionEventRowsSchema.parse(db.prepare(WORKER_SESSIONS_SQL).all({ until: Date.parse(until) }));
  const spawns = rows.filter((r) => r.kind === "agent_spawned");
  const coordinators = new Set([...spawns.map((r) => r.actor), ...spawns.filter((r) => typeof r.profile === "string" && r.profile.includes("coordinator")).map((r) => r.agent)]);
  const sessions = new Map<string, string>();
  for (const { agent, sessionId } of rows) if (typeof sessionId === "string" && !coordinators.has(agent) && !sessions.has(sessionId)) sessions.set(sessionId, agent);
  return [...sessions].map(([sessionId, agent]) => ({ agent, sessionId }));
}

export const SPAWNER_MESSAGES_SQL = [
  `SELECT m.ts, m.target AS agent, coalesce(m.body, '') AS body FROM events m`,
  `WHERE m.kind = 'message' AND m.target IS NOT NULL AND m.ts >= @since AND m.ts < @until`,
  `AND m.actor = (SELECT s.actor FROM events s WHERE s.kind = 'agent_spawned' AND s.target = m.target AND s.ts <= m.ts ORDER BY s.id DESC LIMIT 1) ORDER BY m.id`,
].join(" ");

const spawnerMessageRowsSchema = z.array(z.object({ ts: z.number(), agent: z.string(), body: z.string() }));

/** Messages each agent got in the window from the agent that last spawned it, the follow-ups Q6 classes. */
export function readSpawnerMessages(db: Db, window: { since: string; until: string }): { agent: string; at: string; body: string }[] {
  const rows = spawnerMessageRowsSchema.parse(db.prepare(SPAWNER_MESSAGES_SQL).all({ since: Date.parse(window.since), until: Date.parse(window.until) }));
  return rows.map(({ ts, ...row }) => ({ ...row, at: new Date(ts).toISOString() }));
}
