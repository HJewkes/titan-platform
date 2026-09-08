import { BaseGateStore } from "./base-store.js";
import type { GateRecord } from "./types.js";

export interface MemoryGateStoreOptions {
  /** Epoch-millis clock, injectable so expiry is testable without waiting. */
  now?: () => number;
}

/**
 * In-process gates. Right for tests and for a single-process product that only
 * needs the pause, not the durability; anything that must survive a restart
 * wants `SqliteGateStore`.
 */
export class MemoryGateStore extends BaseGateStore {
  private readonly rows = new Map<string, GateRecord>();

  constructor(options: MemoryGateStoreOptions = {}) {
    super(options.now ?? Date.now);
  }

  protected insert(record: GateRecord): void {
    this.rows.set(record.id, { ...record });
  }

  protected read(id: string): GateRecord | undefined {
    const row = this.rows.get(id);
    return row ? { ...row } : undefined;
  }

  protected update(record: GateRecord): void {
    this.rows.set(record.id, { ...record });
  }

  protected readByStatus(status: GateRecord["status"]): GateRecord[] {
    return [...this.rows.values()].filter((row) => row.status === status).map((row) => ({ ...row }));
  }
}
