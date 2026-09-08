import { randomUUID } from "node:crypto";
import { checkAgainstJsonSchema } from "./json-schema.js";
import {
  GateAlreadyExists,
  GateAlreadySettled,
  GateExpired,
  GateNotFound,
  GatePayloadInvalid,
  type GateInput,
  type GateRecord,
  type GateStore,
} from "./types.js";

/**
 * Every settle rule lives here so the memory and SQLite stores cannot drift
 * apart. Subclasses only move rows.
 */
export abstract class BaseGateStore implements GateStore {
  protected constructor(protected readonly clock: () => number) {}

  protected abstract insert(record: GateRecord): void;
  protected abstract read(id: string): GateRecord | undefined;
  protected abstract update(record: GateRecord): void;
  protected abstract readByStatus(status: GateRecord["status"]): GateRecord[];

  create(input: GateInput): GateRecord {
    const id = input.id ?? randomUUID();
    if (this.read(id)) throw new GateAlreadyExists(id);
    const record: GateRecord = {
      id,
      prompt: input.prompt,
      schema: input.schema,
      status: "pending",
      payload: undefined,
      reason: undefined,
      createdAt: this.nowIso(),
      resolvedAt: undefined,
      expiresAt: toIso(input.expiresAt),
    };
    this.insert(record);
    return record;
  }

  get(id: string): GateRecord | undefined {
    const record = this.read(id);
    return record ? this.lapseIfExpired(record) : undefined;
  }

  resolve(id: string, payload: unknown): GateRecord {
    const record = this.requirePending(id);
    if (record.schema) {
      const issues = checkAgainstJsonSchema(record.schema, payload);
      if (issues.length > 0) throw new GatePayloadInvalid(id, issues);
    }
    const resolved: GateRecord = { ...record, status: "resolved", payload, resolvedAt: this.nowIso() };
    this.update(resolved);
    return resolved;
  }

  cancel(id: string, reason: string): GateRecord {
    const record = this.requirePending(id);
    const cancelled: GateRecord = { ...record, status: "cancelled", reason, resolvedAt: this.nowIso() };
    this.update(cancelled);
    return cancelled;
  }

  listPending(): GateRecord[] {
    return this.readByStatus("pending")
      .map((record) => this.lapseIfExpired(record))
      .filter((record) => record.status === "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private requirePending(id: string): GateRecord {
    const record = this.get(id);
    if (!record) throw new GateNotFound(id);
    if (record.status === "expired") throw new GateExpired(id);
    if (record.status !== "pending") throw new GateAlreadySettled(id, record.status);
    return record;
  }

  /** Expiry is lazy: nothing sweeps the table, so a read is what notices the deadline passed. */
  private lapseIfExpired(record: GateRecord): GateRecord {
    if (record.status !== "pending" || !record.expiresAt) return record;
    if (Date.parse(record.expiresAt) > this.clock()) return record;
    const expired: GateRecord = { ...record, status: "expired", resolvedAt: this.nowIso() };
    this.update(expired);
    return expired;
  }

  protected nowIso(): string {
    return new Date(this.clock()).toISOString();
  }
}

function toIso(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : value.toISOString();
}
