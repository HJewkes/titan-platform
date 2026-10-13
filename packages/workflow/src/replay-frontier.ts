import type { StepOperation } from "./types.js";

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * The results a prior drive recorded, tracked as this drive's replay reads them. A live call made while some are unread
 * means the replay took a path the record does not hold, unless a concurrent branch is still catching up.
 */
export class ReplayFrontier {
  private readonly pending: Set<string>;
  private readonly order: readonly string[];
  private reads = 0;

  constructor(recordedKeys: readonly string[]) {
    this.order = recordedKeys;
    this.pending = new Set(recordedKeys);
  }

  read(key: string): void {
    if (this.pending.delete(key)) this.reads += 1;
  }

  unread(): number {
    return this.pending.size;
  }

  /** The first unread result in recording order. */
  nextUnread(): string | undefined {
    return this.order.find((key) => this.pending.has(key));
  }

  /** Waits while turns keep reading records; true once every record is read, false when a turn reads none. */
  async settled(): Promise<boolean> {
    while (this.pending.size > 0) {
      const before = this.reads;
      await nextTurn();
      if (this.reads === before) return this.pending.size === 0;
    }
    return true;
  }

  evidence(operation: StepOperation, stepId: string): string {
    return `replay diverged: ${operation}("${stepId}") ran live with ${this.unread()} recorded results unread, next ${this.nextUnread()}`;
  }
}
