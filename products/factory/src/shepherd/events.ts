import type { Db, Migration } from "@titan-design/store-sqlite";
import { z } from "zod";

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

/** The append-only history of holds, releases, freezes, thaws and repair stops; nothing is deleted, and only a repoint rewrites a run id, to the run that replaces it. */
export function shepherdEventMigration(version = 16): Migration {
  return { version, name: "factory:shepherd_event", up: (db) => db.exec(EVENT_DDL) };
}

/** Marks the release only Shepherd's re-class of an unread-files hold writes; no CLI argument or other write path reaches the column. */
export function reclassMarkMigration(version = 25): Migration {
  return { version, name: "factory:shepherd_event_reclass", up: (db) => db.exec("ALTER TABLE shepherd_event ADD COLUMN reclass INTEGER NOT NULL DEFAULT 0") };
}

/** SQLite cannot alter a CHECK, so the table is rebuilt with `kinds`; ids, rows and indexes carry over. */
const rebuildWithKinds = (kinds: readonly string[]): string => `
  CREATE TABLE shepherd_event_next (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id   TEXT,
    repo     TEXT NOT NULL,
    pr       INTEGER,
    kind     TEXT NOT NULL CHECK (kind IN (${kinds.map((kind) => `'${kind}'`).join(", ")})),
    reason   TEXT,
    actor    TEXT,
    at       TEXT NOT NULL,
    head_sha TEXT,
    reclass  INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO shepherd_event_next (id, run_id, repo, pr, kind, reason, actor, at, head_sha, reclass)
    SELECT id, run_id, repo, pr, kind, reason, actor, at, head_sha, reclass FROM shepherd_event;
  DROP TABLE shepherd_event;
  ALTER TABLE shepherd_event_next RENAME TO shepherd_event;
  CREATE INDEX shepherd_event_run ON shepherd_event (run_id, id);
  CREATE INDEX shepherd_event_repo ON shepherd_event (repo, id);`;

/** Lets the event history take the repair-stop kinds; runs after `reclassMarkMigration`, whose column it keeps. */
export function widenEventKinds(db: Db): void {
  db.exec(rebuildWithKinds(["hold", "release", "freeze", "thaw", "repair-stop", "repair-go"]));
}

const GATE_CANCEL_KINDS = ["hold", "release", "freeze", "thaw", "repair-stop", "repair-go", "gate-cancel"] as const;

/** A main gate a sweep cancelled because the freeze episode it asked about had thawed (TP-3952). */
export function gateCancelKindMigration(version = 39): Migration {
  return { version, name: "factory:shepherd_event_gate_cancel", up: (db) => db.exec(rebuildWithKinds(GATE_CANCEL_KINDS)) };
}

const ORDER_KINDS = [...GATE_CANCEL_KINDS, "order-reserve", "order-release", "order-expired"] as const;

/** A merge-order reservation taken, released (by its run or a seat's break-glass clear) or expired past its TTL (TP-4098 D). */
export function orderEventKindsMigration(version = 44): Migration {
  return { version, name: "factory:shepherd_event_merge_order", up: (db) => db.exec(rebuildWithKinds(ORDER_KINDS)) };
}

export const EVENT_KINDS = [...ORDER_KINDS, "order-wait"] as const;

/** A merge step that started waiting behind another PR's merge-order reservation (TP-4133). */
export function orderWaitKindMigration(version = 45): Migration {
  return { version, name: "factory:shepherd_event_order_wait", up: (db) => db.exec(rebuildWithKinds(EVENT_KINDS)) };
}

export type EventKind = (typeof EVENT_KINDS)[number];

export interface ShepherdEvent {
  /** Null for a freeze or thaw, or a path repair stop, which belong to a repo, not a run; a gate-cancel names the run whose gate it closed. */
  runId: string | null;
  repo: string;
  pr: number | null;
  kind: EventKind;
  reason: string | null;
  actor: string | null;
  at: string;
  headSha: string | null;
  /** Set only on the release `reclassHold` writes when it swaps an unread-files hold for the PR's real class. */
  reclass?: true;
}

/** Every new row names its actor: a seat or owner name from the CLI, `owner` for a gate answer, else Shepherd itself. Only rows from before TP-2266 are null. */
export const SHEPHERD_ACTOR = "shepherd";

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
  reclass?: number;
}

/** Callers append inside the transaction that makes the state change, so a failed change leaves no event. Only a marked event names the reclass column, so a database without it still takes every other write. */
export function appendEvent(db: Db, event: Partial<ShepherdEvent> & Pick<ShepherdEvent, "repo" | "kind" | "at">): void {
  const mark = event.reclass ? [", reclass", ", 1"] : ["", ""];
  db.prepare(`INSERT INTO shepherd_event (run_id, repo, pr, kind, reason, actor, at, head_sha${mark[0]}) VALUES (?, ?, ?, ?, ?, ?, ?, ?${mark[1]})`).run(
    event.runId ?? null,
    event.repo.toLowerCase(),
    event.pr ?? null,
    event.kind,
    event.reason ?? null,
    event.actor ?? SHEPHERD_ACTOR,
    event.at,
    event.headSha ?? null,
  );
}

/** A run's hold and release events, plus its repo's freeze and thaw events, oldest first. */
export function eventsFor(db: Db, runId: string, repo: string): ShepherdEvent[] {
  const rows = db.prepare<[string, string], EventRow>("SELECT * FROM shepherd_event WHERE run_id = ? OR (run_id IS NULL AND repo = ?) ORDER BY id").all(runId, repo.toLowerCase());
  return rows.map(fromRow);
}

/** The id of a run's latest hold or release event, 0 when it has none. */
export function latestChangeId(db: Db, runId: string): number {
  return z.object({ id: z.number().nullable() }).parse(db.prepare("SELECT MAX(id) AS id FROM shepherd_event WHERE run_id = ? AND kind IN ('hold', 'release')").get(runId)).id ?? 0;
}

/** Every event at or after `since` (an ISO time), oldest first; what stats reads to attribute hold time. */
export function eventsSince(db: Db, since = ""): ShepherdEvent[] {
  return db.prepare<[string], EventRow>("SELECT * FROM shepherd_event WHERE at >= ? ORDER BY id").all(since).map(fromRow);
}

function fromRow(row: EventRow): ShepherdEvent {
  return { runId: row.run_id, repo: row.repo, pr: row.pr, kind: row.kind, reason: row.reason, actor: row.actor, at: row.at, headSha: row.head_sha, ...(row.reclass === 1 && { reclass: true }) };
}
