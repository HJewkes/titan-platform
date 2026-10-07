import { BaseGateStore } from "./base-store.js";
import type { GateAnswerAllowance, GateAuthorize, GateRecord } from "./types.js";

export interface MemoryGateStoreOptions {
  /** Epoch-millis clock, injectable so expiry is testable without waiting. */
  now?: () => number;
  /** Refuses resolvers beyond the default class check; it cannot admit one the default refused. */
  authorize?: GateAuthorize;
  /** Refuse `create` without a `summary` and an `evidenceRef`. Off by default. */
  requireBrief?: boolean;
  /** Answers a non-owner class may give, each exact in class, step and payload. Nothing else widens the default class check. */
  allowances?: readonly GateAnswerAllowance[];
}

/**
 * In-process gates. Right for tests and for a single-process product that only
 * needs the pause, not the durability; anything that must survive a restart
 * wants `SqliteGateStore`.
 */
export class MemoryGateStore extends BaseGateStore {
  private readonly rows = new Map<string, GateRecord>();

  constructor(options: MemoryGateStoreOptions = {}) {
    super(options.now ?? Date.now, options.authorize, options.requireBrief, options.allowances);
  }

  protected insert(record: GateRecord): void {
    this.rows.set(record.id, copy(record));
  }

  protected read(id: string): GateRecord | undefined {
    const row = this.rows.get(id);
    return row ? copy(row) : undefined;
  }

  protected update(record: GateRecord): boolean {
    if (this.rows.get(record.id)?.status !== "pending") return false;
    this.rows.set(record.id, copy(record));
    return true;
  }

  protected readByStatus(status: GateRecord["status"]): GateRecord[] {
    return [...this.rows.values()].filter((row) => row.status === status).map(copy);
  }
}

/** `payload`, `schema`, `resolvedBy`, `rule` and `questions` are nested, so a shallow spread would let a caller rewrite what the store holds. */
function copy(record: GateRecord): GateRecord {
  return {
    ...record,
    payload: record.payload === undefined ? undefined : structuredClone(record.payload),
    schema: record.schema === undefined ? undefined : structuredClone(record.schema),
    resolvedBy: record.resolvedBy && { ...record.resolvedBy },
    rule: record.rule && { ...record.rule, resolvers: [...record.rule.resolvers] },
    questions: record.questions?.map((question) => ({ ...question, options: question.options.map((option) => ({ ...option })) })),
  };
}
