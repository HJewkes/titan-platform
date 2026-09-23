import { ITEM_KINDS, type ItemKind } from "@titan-design/matrix-bus";
import type { CloseOutcome, QueueItem, QueueSource, ResolveResult, SourceEvent, VerdictInput } from "./types.js";

/** An in-memory QueueSource for tests; cursors are the 1-based position in its event log. */
export class MemoryQueueSource implements QueueSource {
  readonly resolutions: Array<{ id: string } & VerdictInput> = [];
  private readonly pending = new Map<string, QueueItem>();
  private readonly log: SourceEvent[] = [];
  private readonly waiters = new Set<() => void>();

  constructor(readonly kinds: readonly ItemKind[] = ITEM_KINDS) {}

  add(item: QueueItem): void {
    this.pending.set(item.id, item);
    this.append({ type: "opened", item, cursor: this.nextCursor() });
  }

  close(id: string, outcome: CloseOutcome, label?: string): void {
    if (!this.pending.delete(id)) return;
    this.append({ type: "closed", id, outcome, label, cursor: this.nextCursor() });
  }

  async open(): Promise<QueueItem[]> {
    return [...this.pending.values()];
  }

  async resolve(id: string, verdict: VerdictInput): Promise<ResolveResult> {
    if (!this.pending.has(id)) return { ok: false, reason: "closed" };
    this.resolutions.push({ id, ...verdict });
    this.close(id, "resolved", verdict.verdict);
    return { ok: true };
  }

  async *tail(cursor: string | undefined, signal: AbortSignal): AsyncIterable<SourceEvent> {
    let next = cursor === undefined ? this.log.length : Number(cursor);
    while (!signal.aborted) {
      while (next < this.log.length) yield this.log[next++] as SourceEvent;
      await this.nextAppend(signal);
    }
  }

  private nextCursor(): string {
    return String(this.log.length + 1);
  }

  private append(event: SourceEvent): void {
    this.log.push(event);
    for (const wake of [...this.waiters]) wake();
  }

  private nextAppend(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        this.waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.waiters.add(done);
      signal.addEventListener("abort", done);
    });
  }
}
