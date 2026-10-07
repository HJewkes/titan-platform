import { quoteIdent, runMigrations, type Db, type Migration } from "@titan-design/store-sqlite";
import { DELEGATE_RESOLVER_CLASSES } from "@titan-design/authority";
import { BaseGateStore } from "./base-store.js";
import {
  GateStoreSchemaOutdated,
  type GateAnswerAllowance,
  type GateAuthorize,
  type GateEvidence,
  type GateEvidencePolicy,
  type GateQuestion,
  type GateRecord,
  type GateResolver,
  type GateRule,
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
 * The triggers that refuse a resolved row naming no resolver, on update and on
 * insert, so a writer that predates `resolved_by` fails loudly instead of resolving anonymously.
 */
export function resolverRequiredTriggerDdl(name: string = DEFAULT_GATE_TABLE): string {
  return (["UPDATE", "INSERT"] as const).map((event) => resolverTrigger(name, event)).join("\n");
}

function resolverTrigger(name: string, event: "UPDATE" | "INSERT"): string {
  const suffix = event === "UPDATE" ? "resolver_required" : "resolver_required_insert";
  return `
    CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`${name}_${suffix}`)}
      BEFORE ${event} ON ${quoteIdent(name)}
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
      if (hasColumn(db, name, "rule")) db.exec(ruleTriggerDdl(db, name));
    },
  };
}

function hasResolverColumn(db: Db, table: string): boolean {
  return hasColumn(db, table, "resolved_by");
}

function hasColumn(db: Db, table: string, column: string): boolean {
  return db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column) !== undefined;
}

const CANONICAL_STATUSES = "'pending', 'resolved', 'cancelled', 'expired'";

/**
 * The triggers that refuse a resolve by a class outside the row's rule, and any
 * change to the rule, so a writer that predates `rule` cannot widen it. The
 * INSERT twin closes REPLACE INTO and DELETE then INSERT, which an UPDATE trigger never sees.
 * A rule-bound row also refuses a status outside the canonical set, so `RESOLVED` cannot slip past the `resolved` test.
 * Without `resolved_by` no resolver can be recorded, so they refuse every resolve
 * of a rule-bound row; whichever migration runs second installs the class-aware form.
 */
function ruleTriggerDdl(db: Db, name: string, delegates = hasDelegateTriggers(db, name)): string {
  const hasResolver = hasResolverColumn(db, name);
  const update = ruleTrigger(name, "UPDATE", "OLD.rule", hasResolver, "NEW.rule IS NOT OLD.rule", delegates);
  const insert = ruleTrigger(name, "INSERT", "NEW.rule", hasResolver, "0", delegates);
  return `${update}\n${insert}\n${replaceGuard(name)}`;
}

/** Once `gateDelegateMigration` has run, a later rule or resolver migration keeps the delegate-aware form rather than narrow it back. */
function hasDelegateTriggers(db: Db, name: string): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(`${name}_rule_resolver`) as { sql: string } | undefined;
  return row?.sql.includes("'$.delegates'") ?? false;
}

/** The classes a rule-bound row admits: its resolvers, and with delegates on, the delegate classes its rule names as a JSON array. */
function admittedClasses(rule: string, delegates: boolean): string {
  const resolvers = `SELECT value FROM json_each(${rule}, '$.resolvers')`;
  if (!delegates) return resolvers;
  const named = DELEGATE_RESOLVER_CLASSES.map((cls) => `'${cls}'`).join(", ");
  return `${resolvers} UNION ALL SELECT value FROM json_each(${rule}, '$.delegates') WHERE json_type(${rule}, '$.delegates') = 'array' AND value IN (${named})`;
}

/** REPLACE deletes the old row before any delete trigger fires without recursive_triggers, so refuse it up front. */
function replaceGuard(name: string): string {
  const trigger = quoteIdent(`${name}_rule_replace`);
  return `
    DROP TRIGGER IF EXISTS ${trigger};
    CREATE TRIGGER ${trigger}
      BEFORE INSERT ON ${quoteIdent(name)}
      FOR EACH ROW WHEN EXISTS (
        SELECT 1 FROM ${quoteIdent(name)} WHERE id = NEW.id AND status = 'pending' AND rule IS NOT NULL AND rule IS NOT NEW.rule
      )
    BEGIN
      SELECT RAISE(ABORT, 'hitl: a pending rule-bound gate cannot be replaced');
    END;
  `;
}

function ruleTrigger(name: string, event: "UPDATE" | "INSERT", rule: string, hasResolver: boolean, ruleChanged: string, delegates: boolean): string {
  const trigger = quoteIdent(event === "UPDATE" ? `${name}_rule_resolver` : `${name}_rule_resolver_insert`);
  const outsideRule = hasResolver
    ? `COALESCE(json_extract(NEW.resolved_by, '$.class'), '') NOT IN (${admittedClasses(rule, delegates)})`
    : "1";
  return `
    DROP TRIGGER IF EXISTS ${trigger};
    CREATE TRIGGER ${trigger}
      BEFORE ${event} ON ${quoteIdent(name)}
      FOR EACH ROW WHEN ${rule} IS NOT NULL OR ${ruleChanged}
    BEGIN
      SELECT RAISE(ABORT, 'hitl: status outside the canonical set') WHERE ${rule} IS NOT NULL AND NEW.status NOT IN (${CANONICAL_STATUSES});
      SELECT RAISE(ABORT, 'hitl: resolver outside the gate rule')
        WHERE ${ruleChanged} OR (NEW.status = 'resolved' AND ${outsideRule});
    END;
  `;
}

/** Adds `rule` and its trigger. Idempotent and backfill-free: gates opened before it carry no rule. */
export function gateRuleMigration(version: number, name: string = DEFAULT_GATE_TABLE): Migration {
  return {
    version,
    name: `hitl:rule:${name}`,
    up: (db) => {
      if (!hasColumn(db, name, "rule")) db.exec(`ALTER TABLE ${quoteIdent(name)} ADD COLUMN rule TEXT`);
      db.exec(ruleTriggerDdl(db, name));
    },
  };
}

const BRIEF_COLUMNS = ["summary", "evidence_ref", "questions"] as const;

/** Adds `summary`, `evidence_ref` and `questions`. Idempotent and backfill-free: gates opened before it carry no brief. */
export function gateBriefMigration(version: number, name: string = DEFAULT_GATE_TABLE): Migration {
  return {
    version,
    name: `hitl:brief:${name}`,
    up: (db) => {
      for (const column of BRIEF_COLUMNS) {
        if (!hasColumn(db, name, column)) db.exec(`ALTER TABLE ${quoteIdent(name)} ADD COLUMN ${column} TEXT`);
      }
    },
  };
}

/**
 * Adds `resolved_evidence`. Idempotent and backfill-free: gates resolved before it carry no evidence. A store
 * refuses a resolve that carries evidence while the table lacks it, rather than drop the evidence.
 */
export function gateEvidenceMigration(version: number, name: string = DEFAULT_GATE_TABLE): Migration {
  return {
    version,
    name: `hitl:evidence:${name}`,
    up: (db) => {
      if (!hasColumn(db, name, "resolved_evidence")) db.exec(`ALTER TABLE ${quoteIdent(name)} ADD COLUMN resolved_evidence TEXT`);
    },
  };
}

/**
 * Reinstalls the rule triggers so a resolve by a delegate class the row's own rule names is no longer aborted. A
 * pending row's rule, delegates included, still cannot change. Adds `resolved_by` and `rule` if missing, so the
 * delegate-aware form is the one installed and a later rule or resolver migration keeps it. Idempotent and backfill-free.
 */
export function gateDelegateMigration(version: number, name: string = DEFAULT_GATE_TABLE): Migration {
  return {
    version,
    name: `hitl:delegate:${name}`,
    up: (db) => {
      for (const column of ["resolved_by", "rule"]) {
        if (!hasColumn(db, name, column)) db.exec(`ALTER TABLE ${quoteIdent(name)} ADD COLUMN ${column} TEXT`);
      }
      db.exec(resolverRequiredTriggerDdl(name));
      db.exec(ruleTriggerDdl(db, name, true));
    },
  };
}

export interface SqliteGateStoreOptions {
  table?: string;
  /** Run `gateMigration`, `gateResolverMigration`, `gateRuleMigration`, `gateBriefMigration`, `gateEvidenceMigration` and `gateDelegateMigration` on construction. Off when the product owns its migration list. */
  migrate?: boolean;
  now?: () => number;
  /** Refuses resolvers beyond the default class check; it cannot admit one the default refused. */
  authorize?: GateAuthorize;
  /** Refuse `create` without a `summary` and an `evidenceRef`. Off by default; needs `gateBriefMigration`. */
  requireBrief?: boolean;
  /** Answers a non-owner class may give, each exact in class, step and payload. Nothing else widens the default class check. */
  allowances?: readonly GateAnswerAllowance[];
  /** Admits a non-owner class on the evidence its resolve carries; see `GateEvidencePolicy`. Needs `gateEvidenceMigration`. */
  evidencePolicy?: GateEvidencePolicy;
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
  resolved_by: string | null;
  /** Absent entirely on a table that has not run `gateRuleMigration`. */
  rule?: string | null;
  /** These three are absent entirely on a table that has not run `gateBriefMigration`. */
  summary?: string | null;
  evidence_ref?: string | null;
  questions?: string | null;
  /** Absent entirely on a table that has not run `gateEvidenceMigration`. */
  resolved_evidence?: string | null;
}

/**
 * Durable gates. Two instances on the same file are two processes as far as the
 * gate is concerned, which is the entire point: whoever resolves the row does
 * not have to be whoever opened it.
 */
export class SqliteGateStore extends BaseGateStore {
  private readonly table: string;
  private readonly columnsSeen = new Set<string>();

  constructor(
    private readonly db: Db,
    options: SqliteGateStoreOptions = {},
  ) {
    super(options.now ?? Date.now, options.authorize, options.requireBrief, options.allowances, options.evidencePolicy);
    this.table = options.table ?? DEFAULT_GATE_TABLE;
    if (options.migrate ?? true) runMigrations(db, defaultMigrations(this.table));
    const missing = missingMigration(db, this.table, options.requireBrief ?? false);
    if (missing) throw new GateStoreSchemaOutdated("", this.table, missing);
  }

  /** Refuses rather than dropping a rule or a brief when the table has no column to hold it. */
  protected insert(record: GateRecord): void {
    const optional = this.optionalColumns(record);
    const names = [...BASE_COLUMNS, ...optional.keys()];
    this.db
      .prepare(`INSERT INTO ${quoteIdent(this.table)} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
      .run(...columns(record), ...optional.values());
  }

  private optionalColumns(record: GateRecord): Map<string, string | null> {
    const optional = new Map<string, string | null>();
    if (record.rule) {
      this.requireColumn(record.id, "rule", "gateRuleMigration");
      if (record.rule.delegates) this.requireDelegateTriggers(record.id);
      optional.set("rule", JSON.stringify(record.rule));
    }
    if (hasBrief(record)) {
      this.requireColumn(record.id, "questions", "gateBriefMigration");
      optional.set("summary", record.summary ?? null);
      optional.set("evidence_ref", record.evidenceRef ?? null);
      optional.set("questions", record.questions ? JSON.stringify(record.questions) : null);
    }
    return optional;
  }

  protected read(id: string): GateRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM ${quoteIdent(this.table)} WHERE id = ?`).get(id) as
      | RawGateRow
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Evidence is written only when given, so a table without `resolved_evidence` still settles every other resolve. */
  protected update(record: GateRecord): boolean {
    const resolvedBy = record.resolvedBy ? JSON.stringify(record.resolvedBy) : null;
    const values = [record.status, toJson(record.payload), record.reason ?? null, record.resolvedAt ?? null, resolvedBy];
    let assignments = "status = ?, payload = ?, reason = ?, resolved_at = ?, resolved_by = ?";
    if (record.resolvedEvidence !== undefined) {
      this.requireColumn(record.id, "resolved_evidence", "gateEvidenceMigration");
      assignments += ", resolved_evidence = ?";
      values.push(JSON.stringify(record.resolvedEvidence));
    }
    const result = this.db
      .prepare(`UPDATE ${quoteIdent(this.table)} SET ${assignments} WHERE id = ? AND status = 'pending'`)
      .run(...values, record.id);
    return result.changes > 0;
  }

  /** Only a present column is cached: a migration can add one while the store is open, never remove one. */
  private requireColumn(gateId: string, column: string, migration: string): void {
    if (this.columnsSeen.has(column)) return;
    if (!hasColumn(this.db, this.table, column)) throw new GateStoreSchemaOutdated(gateId, this.table, migration);
    this.columnsSeen.add(column);
  }

  /** A gate with delegates on a table without the delegate triggers could never be resolved by one, so refuse it at `create`. */
  private requireDelegateTriggers(gateId: string): void {
    if (!hasDelegateTriggers(this.db, this.table)) throw new GateStoreSchemaOutdated(gateId, this.table, "gateDelegateMigration");
  }

  protected readByStatus(status: GateStatus): GateRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM ${quoteIdent(this.table)} WHERE status = ? ORDER BY created_at`)
      .all(status) as RawGateRow[];
    return rows.map(toRecord);
  }
}

/** Names the earliest migration the table lacks, so the error points at the step to add. */
function missingMigration(db: Db, table: string, requireBrief: boolean): string | undefined {
  if (!hasColumn(db, table, "id")) return "gateMigration";
  if (!hasResolverColumn(db, table)) return "gateResolverMigration";
  return requireBrief && !hasColumn(db, table, "questions") ? "gateBriefMigration" : undefined;
}

function defaultMigrations(table: string): Migration[] {
  return [gateMigration(1, table), gateResolverMigration(2, table), gateRuleMigration(3, table), gateBriefMigration(4, table), gateEvidenceMigration(5, table), gateDelegateMigration(6, table)];
}

const BASE_COLUMNS = ["id", "prompt", "schema", "status", "payload", "reason", "created_at", "resolved_at", "expires_at"];

function hasBrief(record: GateRecord): boolean {
  return record.summary !== undefined || record.evidenceRef !== undefined || record.questions !== undefined;
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
    resolvedEvidence: row.resolved_evidence ? (JSON.parse(row.resolved_evidence) as GateEvidence) : undefined,
    rule: row.rule ? (JSON.parse(row.rule) as GateRule) : undefined,
    summary: row.summary ?? undefined,
    evidenceRef: row.evidence_ref ?? undefined,
    questions: row.questions ? (JSON.parse(row.questions) as GateQuestion[]) : undefined,
  };
}
