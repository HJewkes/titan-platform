import { quoteIdent, runMigrations, type Db, type Migration } from "@titan-design/store-sqlite";
import type { ItemKind } from "@titan-design/matrix-bus";
import type { MirrorState, PostedItem, StateChange } from "./types.js";

export const DEFAULT_MIRROR_TABLE_PREFIX = "queue_mirror";

function tableNames(prefix: string): { item: string; applied: string; cursor: string } {
  return { item: `${prefix}_item`, applied: `${prefix}_applied`, cursor: `${prefix}_cursor` };
}

export function mirrorTableDdl(prefix: string = DEFAULT_MIRROR_TABLE_PREFIX): string {
  const { item, applied, cursor } = tableNames(prefix);
  return `
    CREATE TABLE IF NOT EXISTS ${quoteIdent(item)} (
      source_id  TEXT PRIMARY KEY,
      event_id   TEXT NOT NULL UNIQUE,
      kind       TEXT NOT NULL,
      approvable INTEGER NOT NULL,
      status     TEXT NOT NULL,
      expires_at INTEGER,
      record     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${quoteIdent(applied)} (
      resolution_event_id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS ${quoteIdent(cursor)} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      source_cursor TEXT,
      sync_token TEXT
    );
  `;
}

/** Drop into the product's own `runMigrations` list so queue-mirror shares one database with its domain tables. */
export function mirrorMigration(version: number, prefix: string = DEFAULT_MIRROR_TABLE_PREFIX): Migration {
  return { version, name: `queue-mirror:${prefix}`, up: (db: Db) => db.exec(mirrorTableDdl(prefix)) };
}

export interface SqliteMirrorStateOptions {
  tablePrefix?: string;
  /** Run `mirrorMigration` on construction. Off when the product owns its migration list. */
  migrate?: boolean;
}

interface RawItemRow {
  source_id: string;
  event_id: string;
  kind: ItemKind;
  approvable: number;
  status: "open" | "closed";
  expires_at: number | null;
  record: string;
}

interface RawCursorRow {
  source_cursor: string | null;
  sync_token: string | null;
}

function toPostedItem(row: RawItemRow): PostedItem {
  return {
    sourceId: row.source_id,
    eventId: row.event_id,
    kind: row.kind,
    approvable: row.approvable === 1,
    status: row.status,
    expiresAt: row.expires_at ?? undefined,
    record: JSON.parse(row.record),
  };
}

/**
 * Durable mirror state. `commit` runs every write in one transaction, so a
 * failure partway (e.g. a duplicate event id) leaves no partial rows behind.
 */
export class SqliteMirrorState implements MirrorState {
  private readonly itemTable: string;
  private readonly appliedTable: string;
  private readonly cursorTable: string;
  private readonly applyChange: (change: StateChange) => void;

  constructor(
    private readonly db: Db,
    options: SqliteMirrorStateOptions = {},
  ) {
    const prefix = options.tablePrefix ?? DEFAULT_MIRROR_TABLE_PREFIX;
    const names = tableNames(prefix);
    this.itemTable = quoteIdent(names.item);
    this.appliedTable = quoteIdent(names.applied);
    this.cursorTable = quoteIdent(names.cursor);
    if (options.migrate ?? true) runMigrations(db, [mirrorMigration(1, prefix)]);
    this.applyChange = db.transaction((change: StateChange) => this.applyChangeUnsafe(change));
  }

  sourceCursor(): string | undefined {
    return this.readCursor()?.source_cursor ?? undefined;
  }

  syncToken(): string | undefined {
    return this.readCursor()?.sync_token ?? undefined;
  }

  bySourceId(id: string): PostedItem | undefined {
    const row = this.db.prepare(`SELECT * FROM ${this.itemTable} WHERE source_id = ?`).get(id) as
      | RawItemRow
      | undefined;
    return row ? toPostedItem(row) : undefined;
  }

  byEventId(eventId: string): PostedItem | undefined {
    const row = this.db.prepare(`SELECT * FROM ${this.itemTable} WHERE event_id = ?`).get(eventId) as
      | RawItemRow
      | undefined;
    return row ? toPostedItem(row) : undefined;
  }

  openItems(): PostedItem[] {
    const rows = this.db.prepare(`SELECT * FROM ${this.itemTable} WHERE status = 'open'`).all() as RawItemRow[];
    return rows.map(toPostedItem);
  }

  hasApplied(resolutionEventId: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM ${this.appliedTable} WHERE resolution_event_id = ?`).get(
      resolutionEventId,
    );
    return row !== undefined;
  }

  commit(change: StateChange): void {
    this.applyChange(change);
  }

  /** Applies posted before closed, so one change may post and close the same item; matches MemoryMirrorState. */
  private applyChangeUnsafe(change: StateChange): void {
    this.upsertCursor(change);
    for (const item of change.posted ?? []) this.insertItem(item);
    for (const id of change.closed ?? []) this.closeItem(id);
    for (const id of change.applied ?? []) this.markApplied(id);
  }

  private readCursor(): RawCursorRow | undefined {
    return this.db.prepare(`SELECT source_cursor, sync_token FROM ${this.cursorTable} WHERE id = 1`).get() as
      | RawCursorRow
      | undefined;
  }

  private upsertCursor(change: StateChange): void {
    if (change.sourceCursor === undefined && change.syncToken === undefined) return;
    const current = this.readCursor();
    const sourceCursor = change.sourceCursor ?? current?.source_cursor ?? null;
    const syncToken = change.syncToken ?? current?.sync_token ?? null;
    this.db
      .prepare(
        `INSERT INTO ${this.cursorTable} (id, source_cursor, sync_token) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET source_cursor = excluded.source_cursor, sync_token = excluded.sync_token`,
      )
      .run(sourceCursor, syncToken);
  }

  private insertItem(item: PostedItem): void {
    this.db
      .prepare(
        `INSERT INTO ${this.itemTable}
           (source_id, event_id, kind, approvable, status, expires_at, record)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.sourceId,
        item.eventId,
        item.kind,
        item.approvable ? 1 : 0,
        item.status,
        item.expiresAt ?? null,
        JSON.stringify(item.record),
      );
  }

  private closeItem(sourceId: string): void {
    this.db.prepare(`UPDATE ${this.itemTable} SET status = 'closed' WHERE source_id = ?`).run(sourceId);
  }

  private markApplied(resolutionEventId: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO ${this.appliedTable} (resolution_event_id) VALUES (?)`)
      .run(resolutionEventId);
  }
}
