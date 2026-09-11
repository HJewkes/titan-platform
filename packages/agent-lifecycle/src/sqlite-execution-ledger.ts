import { ExecutionTransitionError, reduceExecutionTransition } from "@titan-design/agent-protocol";
import type { ExecutionRecord, ExecutionTransition } from "@titan-design/agent-protocol";
import { nowIso, quoteIdent } from "@titan-design/store-sqlite";
import type { Db } from "@titan-design/store-sqlite";
import { canonicalJson } from "./canonical-json.js";
import type { ApplyExecutionTransitionResult, ExecutionLedger, SqliteExecutionLedgerOptions } from "./execution-ledger.js";
import { DEFAULT_EXECUTION_TABLE } from "./migration.js";

interface StoredEvent { transition: string; record: string }
interface StoredRecord { record: string }

/** Immediate transactions commit a validated snapshot and its immutable receipt together. */
export class SqliteExecutionLedger<TResult = unknown> implements ExecutionLedger<TResult> {
  private readonly snapshot: string;
  private readonly eventTable: string;
  private readonly now: () => string;

  constructor(private readonly db: Db, options: SqliteExecutionLedgerOptions = {}) {
    const table = options.table ?? DEFAULT_EXECUTION_TABLE;
    this.snapshot = quoteIdent(table);
    this.eventTable = quoteIdent(`${table}_event`);
    this.now = options.now ?? nowIso;
  }

  get(executionId: string): ExecutionRecord<TResult> | undefined {
    return this.decode(this.db.prepare(`SELECT record FROM ${this.snapshot} WHERE execution_id = ?`).get(executionId));
  }

  findByRequestKey(requestKey: string): ExecutionRecord<TResult> | undefined {
    return this.decode(this.db.prepare(`SELECT record FROM ${this.snapshot} WHERE request_key = ?`).get(requestKey));
  }

  listRecoverable(limit = 100): ExecutionRecord<TResult>[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("limit must be a positive safe integer");
    const rows = this.db.prepare(`SELECT record FROM ${this.snapshot}
      WHERE phase NOT IN ('succeeded','failed','cancelled','cancellation_unknown')
      ORDER BY prepared_at,execution_id LIMIT ?`).all(limit) as StoredRecord[];
    return rows.map(row => JSON.parse(row.record) as ExecutionRecord<TResult>);
  }

  events(executionId: string): ExecutionTransition<TResult>[] {
    const rows = this.db.prepare(`SELECT transition FROM ${this.eventTable} WHERE execution_id = ? ORDER BY revision`)
      .all(executionId) as { transition: string }[];
    return rows.map(row => JSON.parse(row.transition) as ExecutionTransition<TResult>);
  }

  apply(transition: ExecutionTransition<TResult>): ApplyExecutionTransitionResult<TResult> {
    let canonical: string;
    try { canonical = canonicalJson(transition); }
    catch (error) { return { ok: false, kind: "invalid_transition", reason: message(error) }; }
    // Freeze the caller's input at the transaction boundary; retain no caller-owned references.
    const event = JSON.parse(canonical) as ExecutionTransition<TResult>;
    const problem = envelopeProblem(event);
    if (problem) return { ok: false, kind: "invalid_transition", reason: problem };
    return this.db.transaction(() => this.applyInside(event, canonical)).immediate();
  }

  private applyInside(event: ExecutionTransition<TResult>, canonical: string): ApplyExecutionTransitionResult<TResult> {
    const receipt = this.db.prepare(`SELECT transition,record FROM ${this.eventTable} WHERE execution_id = ? AND event_id = ?`)
      .get(event.executionId, event.eventId) as StoredEvent | undefined;
    if (receipt) return receipt.transition === canonical
      ? { ok: true, applied: false, record: JSON.parse(receipt.record) as ExecutionRecord<TResult> }
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
    if ((event.kind === "prepare" || event.kind === "claim_owner") && (!event.owner || typeof event.owner.leaseUntil !== "string")) {
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
    return raw === undefined ? undefined : JSON.parse((raw as StoredRecord).record) as ExecutionRecord<TResult>;
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }


function envelopeProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "transition must be an object";
  const event = value as Record<string, unknown>;
  for (const key of ["executionId", "eventId", "kind", "occurredAt"]) {
    if (typeof event[key] !== "string" || !event[key].trim()) return `${key} must be a nonempty string`;
  }
  if (!Number.isSafeInteger(event.expectedRevision) || (event.expectedRevision as number) < 0) return "expectedRevision must be a nonnegative safe integer";
  if (!Number.isFinite(Date.parse(event.occurredAt as string))) return "occurredAt must be a valid timestamp";
  return undefined;
}
