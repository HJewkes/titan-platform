import { snapshotBrief } from "./gate-brief.js";
import { checkAgainstJsonSchema } from "./json-schema.js";
import { readDecision, resolverRefusal, ruleResolverRefusal, snapshotAllowances, snapshotResolver, snapshotRule } from "./resolver-policy.js";
import {
  GateAlreadyExists,
  GateAlreadySettled,
  GateExpired,
  GateNotFound,
  GatePayloadInvalid,
  GateResolverRefused,
  type GateAnswerAllowance,
  type GateAuthorize,
  type GateInput,
  type GateRecord,
  type GateResolver,
  type GateStore,
} from "./types.js";

/**
 * Every settle rule lives here so the memory and SQLite stores cannot drift
 * apart. Subclasses only move rows.
 */
export abstract class BaseGateStore implements GateStore {
  protected constructor(
    protected readonly clock: () => number,
    private readonly authorize?: GateAuthorize,
    private readonly requireBrief = false,
    allowances?: readonly GateAnswerAllowance[],
  ) {
    this.allowances = snapshotAllowances(allowances);
  }

  private readonly allowances: readonly GateAnswerAllowance[];

  protected abstract insert(record: GateRecord): void;
  protected abstract read(id: string): GateRecord | undefined;
  protected abstract update(record: GateRecord): void;
  protected abstract readByStatus(status: GateRecord["status"]): GateRecord[];

  create(input: GateInput): GateRecord {
    const id = input.id ?? globalThis.crypto.randomUUID();
    const rule = input.rule === undefined ? undefined : snapshotRule(id, input.rule);
    const brief = snapshotBrief(id, input, this.requireBrief);
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
      resolvedBy: undefined,
      rule,
      ...brief,
    };
    this.insert(record);
    return record;
  }

  get(id: string): GateRecord | undefined {
    const record = this.read(id);
    return record ? this.lapseIfExpired(record) : undefined;
  }

  resolve(id: string, payload: unknown, resolvedBy: GateResolver): GateRecord {
    if (!resolvedBy) throw new GateResolverRefused(id, undefined, "a resolver is required");
    const resolver = snapshotResolver(id, resolvedBy);
    const record = this.requirePending(id);
    this.requireAuthorized(record, resolver, payload);
    if (record.schema) {
      const issues = checkAgainstJsonSchema(record.schema, payload);
      if (issues.length > 0) throw new GatePayloadInvalid(id, issues);
    }
    const resolved: GateRecord = { ...record, status: "resolved", payload, resolvedAt: this.nowIso(), resolvedBy: resolver };
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

  /** The default check (or a listed allowance) runs first, the gate's rule second and `authorize` last, so each can only narrow who may resolve. */
  private requireAuthorized(record: GateRecord, resolver: Readonly<GateResolver>, payload: unknown): void {
    const refusal = resolverRefusal(record.id, resolver, payload, this.allowances);
    if (refusal) throw new GateResolverRefused(record.id, resolver.class, refusal);
    const ruleRefusal = ruleResolverRefusal(record, resolver);
    if (ruleRefusal) throw new GateResolverRefused(record.id, resolver.class, ruleRefusal);
    if (!this.authorize) return;
    const decision = readDecision(record.id, this.authorize(Object.freeze({ ...record }), resolver));
    if (!decision.allowed) throw new GateResolverRefused(record.id, resolver.class, decision.reason);
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
