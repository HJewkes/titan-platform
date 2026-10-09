import type { Db, Migration } from "@titan-design/store-sqlite";

const EVENT_DDL = `
  CREATE TABLE shepherd_event (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id   TEXT,
    repo     TEXT NOT NULL,
    pr       INTEGER,
    kind     TEXT NOT NULL CHECK (kind IN ('hold', 'release', 'freeze', 'thaw')),
    reason   TEXT,
    actor    TEXT,
    at       TEXT NOT NULL,
    head_sha TEXT
  );
  CREATE INDEX shepherd_event_run ON shepherd_event (run_id, id);
  CREATE INDEX shepherd_event_repo ON shepherd_event (repo, id);`;

/** The append-only history of holds, releases, freezes and thaws; nothing here is ever updated or deleted. */
export function shepherdEventMigration(version = 15): Migration {
  return { version, name: "factory:shepherd_event", up: (db) => db.exec(EVENT_DDL) };
}

export const EVENT_KINDS = ["hold", "release", "freeze", "thaw"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface ShepherdEvent {
  /** Null for a freeze or thaw, which belong to a repo, not a run. */
  runId: string | null;
  repo: string;
  pr: number | null;
  kind: EventKind;
  reason: string | null;
  actor: string | null;
  at: string;
  headSha: string | null;
}

/** Who made the change and the PR head it was made at, where the caller knows them. */
export interface EventContext {
  actor?: string;
  headSha?: string;
}

interface EventRow {
  run_id: string | null;
  repo: string;
  pr: number | null;
  kind: EventKind;
  reason: string | null;
  actor: string | null;
  at: string;
  head_sha: string | null;
}

/** Callers append inside the transaction that makes the state change, so a failed change leaves no event. */
export function appendEvent(db: Db, event: Partial<ShepherdEvent> & Pick<ShepherdEvent, "repo" | "kind" | "at">): void {
  db.prepare("INSERT INTO shepherd_event (run_id, repo, pr, kind, reason, actor, at, head_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    event.runId ?? null,
    event.repo.toLowerCase(),
    event.pr ?? null,
    event.kind,
    event.reason ?? null,
    event.actor ?? null,
    event.at,
    event.headSha ?? null,
  );
}

/** A run's hold and release events, plus its repo's freeze and thaw events, oldest first. */
export function eventsFor(db: Db, runId: string, repo: string): ShepherdEvent[] {
  const rows = db.prepare("SELECT * FROM shepherd_event WHERE run_id = ? OR (run_id IS NULL AND repo = ?) ORDER BY id").all(runId, repo.toLowerCase()) as EventRow[];
  return rows.map(fromRow);
}

/** Every event at or after `since` (an ISO time), oldest first; what stats reads to attribute hold time. */
export function eventsSince(db: Db, since = ""): ShepherdEvent[] {
  return (db.prepare("SELECT * FROM shepherd_event WHERE at >= ? ORDER BY id").all(since) as EventRow[]).map(fromRow);
}

function fromRow(row: EventRow): ShepherdEvent {
  return { runId: row.run_id, repo: row.repo, pr: row.pr, kind: row.kind, reason: row.reason, actor: row.actor, at: row.at, headSha: row.head_sha };
}
