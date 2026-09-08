import { quoteIdent, runMigrations, type Db, type Migration } from "@titan-design/store-sqlite";
import { BaseGateStore } from "./base-store.js";
import type { GateRecord, GateStatus, JsonSchema } from "./types.js";

export const DEFAULT_GATE_TABLE = "hitl_gate";

export function gateTableDdl(name: string = DEFAULT_GATE_TABLE): string {
  const t = quoteIdent(name);
  return `
    CREATE TABLE IF NOT EXISTS ${t} (
      id          TEXT PRIMARY KEY,
      prompt      TEXT NOT NULL,
      schema      TEXT,
      status      TEXT NOT NULL DEFAULT 'pending',
      payload     TEXT,
      reason      TEXT,
      created_at  TEXT NOT NULL,
      resolved_at TEXT,
      expires_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS ${quoteIdent(`${name}_pending`)}
      ON ${t} (created_at) WHERE status = 'pending';
  `;
}

/** Drop into the product's own `runMigrations` list so hitl shares one database with its domain tables. */
export function gateMigration(version: number, name: string = DEFAULT_GATE_TABLE): Migration {
  return { version, name: `hitl:${name}`, up: (db) => db.exec(gateTableDdl(name)) };
}

export interface SqliteGateStoreOptions {
  table?: string;
  /** Run `gateMigration` on construction. Off when the product owns its migration list. */
  migrate?: boolean;
  now?: () => number;
}

interface RawGateRow {
  id: string;
  prompt: string;
  schema: string | null;
  status: GateStatus;
  payload: string | null;
  reason: string | null;
  created_at: string;
  resolved_at: string | null;
  expires_at: string | null;
}

/**
 * Durable gates. Two instances on the same file are two processes as far as the
 * gate is concerned, which is the entire point: whoever resolves the row does
 * not have to be whoever opened it.
 */
export class SqliteGateStore extends BaseGateStore {
  private readonly table: string;

  constructor(
    private readonly db: Db,
    options: SqliteGateStoreOptions = {},
  ) {
    super(options.now ?? Date.now);
    this.table = options.table ?? DEFAULT_GATE_TABLE;
    if (options.migrate ?? true) runMigrations(db, [gateMigration(1, this.table)]);
  }

  protected insert(record: GateRecord): void {
    this.db
      .prepare(
        `INSERT INTO ${quoteIdent(this.table)}
           (id, prompt, schema, status, payload, reason, created_at, resolved_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...columns(record));
  }

  protected read(id: string): GateRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM ${quoteIdent(this.table)} WHERE id = ?`).get(id) as
      | RawGateRow
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  protected update(record: GateRecord): void {
    this.db
      .prepare(
        `UPDATE ${quoteIdent(this.table)}
            SET status = ?, payload = ?, reason = ?, resolved_at = ?
          WHERE id = ?`,
      )
      .run(record.status, toJson(record.payload), record.reason ?? null, record.resolvedAt ?? null, record.id);
  }

  protected readByStatus(status: GateStatus): GateRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM ${quoteIdent(this.table)} WHERE status = ? ORDER BY created_at`)
      .all(status) as RawGateRow[];
    return rows.map(toRecord);
  }
}

function columns(record: GateRecord): unknown[] {
  return [
    record.id,
    record.prompt,
    record.schema ? JSON.stringify(record.schema) : null,
    record.status,
    toJson(record.payload),
    record.reason ?? null,
    record.createdAt,
    record.resolvedAt ?? null,
    record.expiresAt ?? null,
  ];
}

/** `undefined` and a stored JSON `null` are different states, so only the former becomes a SQL NULL. */
function toJson(payload: unknown): string | null {
  return payload === undefined ? null : JSON.stringify(payload);
}

function toRecord(row: RawGateRow): GateRecord {
  return {
    id: row.id,
    prompt: row.prompt,
    schema: row.schema ? (JSON.parse(row.schema) as JsonSchema) : undefined,
    status: row.status,
    payload: row.payload === null ? undefined : JSON.parse(row.payload),
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
  };
}
