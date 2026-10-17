import type { Db, Migration } from "@titan-design/store-sqlite";
import { z } from "zod";

const EVENT_LOG_DDL = `
  CREATE TABLE factory_event (
    seq            INTEGER PRIMARY KEY AUTOINCREMENT,
    source         TEXT NOT NULL CHECK (source IN ('webhook', 'backstop', 'store', 'broker', 'merge-log')),
    kind           TEXT NOT NULL,
    repo           TEXT,
    subject        TEXT NOT NULL,
    keys           TEXT NOT NULL,
    delivery_id    TEXT UNIQUE,
    occurrence_key TEXT NOT NULL UNIQUE,
    observed_at    TEXT NOT NULL,
    source_at      TEXT,
    payload        TEXT NOT NULL
  );
  CREATE INDEX factory_event_subject ON factory_event (subject, seq);
  CREATE INDEX factory_event_repo ON factory_event (repo, seq);
  CREATE TRIGGER factory_event_no_update BEFORE UPDATE ON factory_event BEGIN SELECT RAISE(ABORT, 'append-only'); END;
  CREATE TRIGGER factory_event_no_delete BEFORE DELETE ON factory_event BEGIN SELECT RAISE(ABORT, 'append-only'); END;`;

/** The v9.1 event log (TP-3095 S1); 30 follows the host's 28 and TP-3388's merge_op at 29. */
export function eventLogMigration(version = 30): Migration {
  return { version, name: "factory:event_log", up: (db) => db.exec(EVENT_LOG_DDL) };
}

/** The GitHub Activity Events API is never a source: its latency runs from 30 s to 6 h. */
type EventSource = "webhook" | "backstop" | "store" | "broker" | "merge-log";

/** A parsed projection, never a raw body; past this the append refuses rather than store user data wholesale. */
export const MAX_PAYLOAD_BYTES = 16 * 1024;

interface EventBase {
  source: EventSource;
  kind: string;
  /** Lowercased `owner/name`; absent for an event no repository owns. */
  repo?: string;
  /** What a waiter matches on, such as `<repo>@<sha>` or `<repo>#<pr>`. */
  subject: string;
  keys: Record<string, unknown>;
  /** Namespaced transport id, such as `webhook:<X-GitHub-Delivery>`; polled and store rows have none. */
  deliveryId?: string;
  observedAt: string;
  sourceAt?: string;
  payload: unknown;
}

/** GitHub gave the occurrence its own identity, so a repeated key is a duplicate. */
export interface IdentityEvent extends EventBase {
  rule: "identity";
  occurrenceKey: string;
}

/** GitHub gave only a current value: the append inserts when it differs from the subject's last row of this kind. */
export interface TransitionEvent extends EventBase {
  rule: "transition";
  /** The key is this, then `|after:<seq of the subject's last row of this kind, or 0>`. */
  keyBase: string;
  /** Stored in `keys.value`, which is what the next transition compares against. */
  value: string;
}

type NewEvent = IdentityEvent | TransitionEvent;

type AppendResult = { inserted: true; seq: number } | { inserted: false; seq: number; by: "delivery" | "occurrence" | "unchanged" };

interface EventRow {
  seq: number;
  source: EventSource;
  kind: string;
  repo: string | null;
  subject: string;
  keys: Record<string, unknown>;
  deliveryId: string | null;
  occurrenceKey: string;
  observedAt: string;
  sourceAt: string | null;
  payload: unknown;
}

interface StoredRow {
  seq: number;
  source: EventSource;
  kind: string;
  repo: string | null;
  subject: string;
  keys: string;
  delivery_id: string | null;
  occurrence_key: string;
  observed_at: string;
  source_at: string | null;
  payload: string;
}

const Keys = z.record(z.string(), z.unknown());
const parseKeys = (text: string): Record<string, unknown> => Keys.parse(JSON.parse(text));

const seqWhere = (db: Db, where: string, value: string): number | undefined =>
  db.prepare<[string], { seq: number }>(`SELECT seq FROM factory_event WHERE ${where} = ?`).get(value)?.seq;

function lastOfKind(db: Db, subject: string, kind: string): { seq: number; value: unknown } | undefined {
  const row = db
    .prepare<[string, string], { seq: number; keys: string }>("SELECT seq, keys FROM factory_event WHERE subject = ? AND kind = ? ORDER BY seq DESC LIMIT 1")
    .get(subject, kind);
  return row === undefined ? undefined : { seq: row.seq, value: parseKeys(row.keys).value };
}

type Resolved = { key: string; keys: Record<string, unknown> } | { duplicate: AppendResult };

function resolveKey(db: Db, event: NewEvent): Resolved {
  if (event.rule === "identity") return { key: event.occurrenceKey, keys: event.keys };
  const last = lastOfKind(db, event.subject, event.kind);
  if (last !== undefined && last.value === event.value) return { duplicate: { inserted: false, seq: last.seq, by: "unchanged" } };
  return { key: `${event.keyBase}|after:${last?.seq ?? 0}`, keys: { ...event.keys, value: event.value } };
}

function insert(db: Db, event: NewEvent, key: string, keys: Record<string, unknown>, payload: string): number {
  const result = db
    .prepare(
      `INSERT INTO factory_event (source, kind, repo, subject, keys, delivery_id, occurrence_key, observed_at, source_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(event.source, event.kind, event.repo ?? null, event.subject, JSON.stringify(keys), event.deliveryId ?? null, key, event.observedAt, event.sourceAt ?? null, payload);
  return Number(result.lastInsertRowid);
}

function appendInside(db: Db, event: NewEvent, payload: string): AppendResult {
  const byDelivery = event.deliveryId === undefined ? undefined : seqWhere(db, "delivery_id", event.deliveryId);
  if (byDelivery !== undefined) return { inserted: false, seq: byDelivery, by: "delivery" };
  const resolved = resolveKey(db, event);
  if ("duplicate" in resolved) return resolved.duplicate;
  const byOccurrence = seqWhere(db, "occurrence_key", resolved.key);
  if (byOccurrence !== undefined) return { inserted: false, seq: byOccurrence, by: "occurrence" };
  return { inserted: true, seq: insert(db, event, resolved.key, resolved.keys, payload) };
}

/**
 * Append one observation, or name the row it duplicates. The read and the insert share one BEGIN IMMEDIATE transaction,
 * so the write lock is held before the duplicate checks run: a racing writer waits, then sees this row.
 */
export function appendEvent(db: Db, event: NewEvent): AppendResult {
  const payload = JSON.stringify(event.payload);
  if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) throw new RangeError(`event payload is ${Buffer.byteLength(payload)} bytes; the cap is ${MAX_PAYLOAD_BYTES}`);
  return db.transaction(() => appendInside(db, event, payload)).immediate();
}

/** The commit-ordered high-water mark: every row at or below it is visible to whoever read it. */
export function headSeq(db: Db): number {
  return db.prepare<[], { head: number | null }>("SELECT MAX(seq) AS head FROM factory_event").get()?.head ?? 0;
}

type ReadEventsQuery = ({ subject: string; repo?: never } | { repo: string; subject?: never }) & {
  sinceSeq: number;
  kind?: string;
  /** Defaults to 500. */
  limit?: number;
};

const fromRow = (row: StoredRow): EventRow => ({
  seq: row.seq,
  source: row.source,
  kind: row.kind,
  repo: row.repo,
  subject: row.subject,
  keys: parseKeys(row.keys),
  deliveryId: row.delivery_id,
  occurrenceKey: row.occurrence_key,
  observedAt: row.observed_at,
  sourceAt: row.source_at,
  payload: JSON.parse(row.payload) as unknown,
});

/** Rows above `sinceSeq` for one subject or one repo, in ascending seq, at most `limit`. */
export function readEvents(db: Db, query: ReadEventsQuery): EventRow[] {
  const [column, value] = query.subject !== undefined ? ["subject", query.subject] : ["repo", query.repo];
  const kindClause = query.kind === undefined ? "" : " AND kind = @kind";
  const rows = db
    .prepare<Record<string, unknown>, StoredRow>(`SELECT * FROM factory_event WHERE ${column} = @value AND seq > @since${kindClause} ORDER BY seq LIMIT @limit`)
    .all({ value, since: query.sinceSeq, limit: query.limit ?? 500, ...(query.kind !== undefined && { kind: query.kind }) });
  return rows.map(fromRow);
}
