import { EXECUTION_PHASES, ExecutionTransitionError, isTerminalExecutionPhase, reduceExecutionTransition } from "@titan-design/agent-protocol";
import type { ExecutionRecord, ExecutionTransition } from "@titan-design/agent-protocol";
import { executionRecordSchema, executionTransitionSchema } from "@titan-design/agent-protocol/lifecycle-schema";
import { nowIso, quoteIdent } from "@titan-design/store-sqlite";
import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import type { ApplyExecutionTransitionResult, ExecutionLedger, SqliteExecutionLedgerOptions } from "./execution-ledger.js";
import { DEFAULT_EXECUTION_TABLE } from "./migration.js";

function textColumn(row: unknown, key: "record" | "transition"): string {
  const value = typeof row === "object" && row !== null ? Reflect.get(row, key) : undefined;
  if (typeof value !== "string") throw new TypeError(`stored row has no ${key}`);
  return value;
}

function parseStored<T>(schema: z.ZodType<T>, what: string, text: string): T {
  let json: unknown;
  try { json = JSON.parse(text); }
  catch (error) { throw new TypeError(`stored ${what} is not valid JSON: ${message(error)}`); }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new TypeError(`stored ${what} is malformed: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

function lacksLease(owner: { leaseUntil: unknown } | undefined): boolean {
  return !owner || typeof owner.leaseUntil !== "string";
}

const LIVE_EXECUTION_PHASES = EXECUTION_PHASES.filter(phase => !isTerminalExecutionPhase(phase));

/** `phase IN` lets SQLite use the phase index; `NOT IN` scans every finished execution. */
export function recoverableSql(snapshot: string): string {
  return `SELECT execution_id,record FROM ${snapshot}
      WHERE phase IN (${LIVE_EXECUTION_PHASES.map(phase => `'${phase}'`).join(",")})
      ORDER BY prepared_at,execution_id LIMIT ?`;
}

/** Immediate transactions commit a validated snapshot and its immutable receipt together. */
export class SqliteExecutionLedger<TResult = unknown> implements ExecutionLedger<TResult> {
  private readonly snapshot: string;
  private readonly eventTable: string;
  private readonly now: () => string;
  private readonly warn: (line: string) => void;
  private readonly recordSchema: z.ZodType<ExecutionRecord<TResult>>;
  private readonly transitionSchema: z.ZodType<ExecutionTransition<TResult>>;

  constructor(private readonly db: Db, options: SqliteExecutionLedgerOptions = {}) {
    const table = options.table ?? DEFAULT_EXECUTION_TABLE;
    this.snapshot = quoteIdent(table);
    this.eventTable = quoteIdent(`${table}_event`);
    this.now = options.now ?? nowIso;
    this.warn = options.warn ?? (line => { console.warn(line); });
    // TResult is erased in storage: the ledger cannot validate a result it has no schema for, so the caller owns that contract.
    const result = z.unknown() as z.ZodType<TResult>;
    this.recordSchema = executionRecordSchema(result);
    this.transitionSchema = executionTransitionSchema(result);
  }

  get(executionId: string): ExecutionRecord<TResult> | undefined {
    return this.decode(this.db.prepare(`SELECT record FROM ${this.snapshot} WHERE execution_id = ?`).get(executionId));
  }

  findByRequestKey(requestKey: string): ExecutionRecord<TResult> | undefined {
    return this.decode(this.db.prepare(`SELECT record FROM ${this.snapshot} WHERE request_key = ?`).get(requestKey));
  }

  listRecoverable(limit = 100): ExecutionRecord<TResult>[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("limit must be a positive safe integer");
    const rows = this.db.prepare(recoverableSql(this.snapshot)).all(limit);
    return rows.flatMap(row => this.recoverableRecord(row));
  }

  /** Recovery must reach every other execution, so one unreadable row is logged and skipped rather than thrown. */
  private recoverableRecord(row: unknown): ExecutionRecord<TResult>[] {
    try { return [this.parseRecord(textColumn(row, "record"))]; }
    catch (error) {
      const id = row !== null && typeof row === "object" ? String(Reflect.get(row, "execution_id")) : "unknown";
      this.warn(`skipping unreadable execution ${id} during recovery: ${message(error).split("\n")[0]}`);
      return [];
    }
  }

  events(executionId: string): ExecutionTransition<TResult>[] {
    const rows = this.db.prepare(`SELECT transition FROM ${this.eventTable} WHERE execution_id = ? ORDER BY revision`)
      .all(executionId);
    return rows.map(row => parseStored(this.transitionSchema, "execution transition", textColumn(row, "transition")));
  }

  apply(transition: ExecutionTransition<TResult>): ApplyExecutionTransitionResult<TResult> {
    let canonical: string;
    try { canonical = canonicalJson(transition); }
    catch (error) { return { ok: false, kind: "invalid_transition", reason: message(error) }; }
    // Freeze the caller's input at the transaction boundary; retain no caller-owned references.
    const event: ExecutionTransition<TResult> = JSON.parse(canonical);
    const problem = envelopeProblem(event);
    if (problem) return { ok: false, kind: "invalid_transition", reason: problem };
    return this.db.transaction(() => this.applyInside(event, canonical)).immediate();
  }

  private applyInside(event: ExecutionTransition<TResult>, canonical: string): ApplyExecutionTransitionResult<TResult> {
    const receipt = this.db.prepare(`SELECT transition,record FROM ${this.eventTable} WHERE execution_id = ? AND event_id = ?`)
      .get(event.executionId, event.eventId);
    if (receipt) return textColumn(receipt, "transition") === canonical
      ? { ok: true, applied: false, record: this.parseRecord(textColumn(receipt, "record")) }
      : { ok: false, kind: "event_conflict", reason: "event ID already records a different transition" };
    const current = this.get(event.executionId);
    const invalid = this.validateLiveTransition(current, event);
    if (invalid) return invalid;
    let next: ExecutionRecord<TResult>;
    try { next = reduceExecutionTransition(current, event); }
    catch (error) {
      if (error instanceof ExecutionTransitionError) return { ok: false, kind: error.code, reason: error.message, current };
      if (error instanceof TypeError) return { ok: false, kind: "invalid_transition", reason: error.message, current };
      throw error;
    }
    this.save(next, canonicalJson(next));
    this.db.prepare(`INSERT INTO ${this.eventTable} (execution_id,event_id,revision,transition,record) VALUES (?,?,?,?,?)`)
      .run(event.executionId, event.eventId, next.revision, canonical, canonicalJson(next));
    return { ok: true, applied: true, record: next };
  }

  private validateLiveTransition(current: ExecutionRecord<TResult> | undefined, event: ExecutionTransition<TResult>): ApplyExecutionTransitionResult<TResult> | undefined {
    if ((event.kind === "prepare" || event.kind === "claim_owner") && lacksLease(event.owner)) {
      return { ok: false, kind: "invalid_transition", reason: "owner lease is required", current };
    }
    const now = Date.parse(this.now());
    if (!Number.isFinite(now)) throw new TypeError("ledger clock must return a valid timestamp");
    if (Date.parse(event.occurredAt) > now) return { ok: false, kind: "invalid_transition", reason: "event timestamp is in the ledger's future", current };
    if (current && "fence" in event && (!current.owner || Date.parse(current.owner.leaseUntil) <= now)) {
      return { ok: false, kind: "ownership_lost", reason: "owner lease has expired at the ledger clock", current };
    }
    if ((event.kind === "prepare" || event.kind === "claim_owner") && Date.parse(event.owner.leaseUntil) <= now) {
      return { ok: false, kind: "ownership_lost", reason: "new owner lease is already expired", current };
    }
    if (event.kind === "renew_owner" && Date.parse(event.leaseUntil) <= now) {
      return { ok: false, kind: "ownership_lost", reason: "renewed lease is already expired", current };
    }
    if (event.kind === "prepare") {
      const existing = this.findByRequestKey(event.requestKey);
      if (existing && existing.execution.executionId !== event.executionId) {
        return { ok: false, kind: "event_conflict", reason: "request key already belongs to a different execution", current: existing };
      }
    }
    return undefined;
  }

  private save(record: ExecutionRecord<TResult>, serialized: string): void {
    this.db.prepare(`INSERT INTO ${this.snapshot}
      (execution_id,request_key,phase,revision,owner_id,owner_generation,lease_until,prepared_at,updated_at,record)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(execution_id) DO UPDATE SET
      phase=excluded.phase,revision=excluded.revision,owner_id=excluded.owner_id,owner_generation=excluded.owner_generation,
      lease_until=excluded.lease_until,updated_at=excluded.updated_at,record=excluded.record`)
      .run(record.execution.executionId, record.requestKey, record.phase, record.revision, record.owner?.supervisorId ?? null,
        record.ownerGeneration, record.owner?.leaseUntil ?? null, record.preparedAt, record.lastObservedAt, serialized);
  }

  private decode(raw: unknown): ExecutionRecord<TResult> | undefined {
    return raw === undefined ? undefined : this.parseRecord(textColumn(raw, "record"));
  }

  private parseRecord(text: string): ExecutionRecord<TResult> {
    return parseStored(this.recordSchema, "execution record", text);
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }


function envelopeProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "transition must be an object";
  const field = (key: string): unknown => Reflect.get(value, key);
  for (const key of ["executionId", "eventId", "kind", "occurredAt"]) {
    const item = field(key);
    if (typeof item !== "string" || !item.trim()) return `${key} must be a nonempty string`;
  }
  const revision = field("expectedRevision");
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return "expectedRevision must be a nonnegative safe integer";
  const occurredAt = field("occurredAt");
  if (typeof occurredAt !== "string" || !Number.isFinite(Date.parse(occurredAt))) return "occurredAt must be a valid timestamp";
  return undefined;
}
