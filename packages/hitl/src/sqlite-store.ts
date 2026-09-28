import { quoteIdent, runMigrations, type Db, type Migration } from "@titan-design/store-sqlite";
import { BaseGateStore } from "./base-store.js";
import {
  GateStoreSchemaOutdated,
  type GateAuthorize,
  type GateRecord,
  type GateResolver,
  type GateStatus,
  type JsonSchema,
} from "./types.js";

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

/**
 * The trigger that refuses a resolve naming no resolver, so a writer that
 * predates `resolved_by` fails loudly instead of resolving anonymously.
 */
export function resolverRequiredTriggerDdl(name: string = DEFAULT_GATE_TABLE): string {
  return `
    CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`${name}_resolver_required`)}
      BEFORE UPDATE ON ${quoteIdent(name)}
      FOR EACH ROW WHEN NEW.status = 'resolved' AND NEW.resolved_by IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'hitl: resolvedBy required');
    END;
  `;
}

/**
 * Adds `resolved_by` and the resolver trigger. Idempotent and backfill-free:
 * gates resolved before it keep an unknown resolver rather than a guessed one.
 */
export function gateResolverMigration(version: number, name: string = DEFAULT_GATE_TABLE): Migration {
  return {
    version,
    name: `hitl:resolver:${name}`,
    up: (db) => {
      if (!hasResolverColumn(db, name)) db.exec(`ALTER TABLE ${quoteIdent(name)} ADD COLUMN resolved_by TEXT`);
      db.exec(resolverRequiredTriggerDdl(name));
    },
  };
}

function hasResolverColumn(db: Db, table: string): boolean {
  return db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = 'resolved_by'").get(table) !== undefined;
}

export interface SqliteGateStoreOptions {
  table?: string;
  /** Run `gateMigration` on construction. Off when the product owns its migration list. */
  migrate?: boolean;
  now?: () => number;
  /** Refuses resolvers beyond the default class check; it cannot admit one the default refused. */
  authorize?: GateAuthorize;
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
  /** Absent entirely on a table that has not run `gateResolverMigration`. */
  resolved_by?: string | null;
}

/**
 * Durable gates. Two instances on the same file are two processes as far as the
 * gate is concerned, which is the entire point: whoever resolves the row does
 * not have to be whoever opened it.
 */
export class SqliteGateStore extends BaseGateStore {
  private readonly table: string;
  private resolverColumnSeen = false;

  constructor(
    private readonly db: Db,
    options: SqliteGateStoreOptions = {},
  ) {
    super(options.now ?? Date.now, options.authorize);
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
    if (record.resolvedBy) {
      this.updateWithResolver(record, record.resolvedBy);
      return;
    }
    this.db
      .prepare(
        `UPDATE ${quoteIdent(this.table)}
            SET status = ?, payload = ?, reason = ?, resolved_at = ?
          WHERE id = ?`,
      )
      .run(record.status, toJson(record.payload), record.reason ?? null, record.resolvedAt ?? null, record.id);
  }

  /** Refuses rather than dropping the resolver when the table has no column to hold it. */
  private updateWithResolver(record: GateRecord, resolvedBy: GateResolver): void {
    if (!this.resolverColumnPresent()) {
      throw new GateStoreSchemaOutdated(record.id, this.table, "gateResolverMigration");
    }
    this.db
      .prepare(
        `UPDATE ${quoteIdent(this.table)}
            SET status = ?, payload = ?, reason = ?, resolved_at = ?, resolved_by = ?
          WHERE id = ?`,
      )
      .run(
        record.status,
        toJson(record.payload),
        record.reason ?? null,
        record.resolvedAt ?? null,
        JSON.stringify(resolvedBy),
        record.id,
      );
  }

  /** Only a positive probe is cached, so a migration run after construction is still noticed. */
  private resolverColumnPresent(): boolean {
    if (!this.resolverColumnSeen) this.resolverColumnSeen = hasResolverColumn(this.db, this.table);
    return this.resolverColumnSeen;
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
    resolvedBy: row.resolved_by ? (JSON.parse(row.resolved_by) as GateResolver) : undefined,
  };
}
