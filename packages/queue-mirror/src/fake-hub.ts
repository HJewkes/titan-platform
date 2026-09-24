import { ITEM_KEY, assertSendable, type MatrixEvent, type SyncBatch, type SyncOptions } from "@titan-design/matrix-bus";
import type { MirrorBus } from "./mirror.js";

interface Batch {
  since: string;
  events: MatrixEvent[];
  limited: boolean;
}

/** A test-only in-memory homeserver: dedupes txnIds, records every send, and serves injected /sync batches. */
export class FakeHub implements MirrorBus {
  readonly sent: MatrixEvent[] = [];
  private readonly txns = new Map<string, string>();
  private readonly batches: Batch[] = [];
  private readonly waiters = new Set<() => void>();
  private failSends = 0;
  private failSyncs = 0;

  constructor(readonly userId = "@ac-edge1:hub.test") {}

  async send(roomId: string, type: string, content: Record<string, unknown>, txnId?: string): Promise<{ event_id: string }> {
    assertSendable(content);
    if (this.failSends > 0 && this.failSends--) throw new Error("send failed");
    const known = txnId === undefined ? undefined : this.txns.get(txnId);
    if (known) return { event_id: known };
    const event: MatrixEvent = { type, event_id: `$hub${this.sent.length + 1}`, sender: this.userId, content, room_id: roomId };
    this.sent.push(event);
    if (txnId !== undefined) this.txns.set(txnId, event.event_id);
    return { event_id: event.event_id };
  }

  items(): MatrixEvent[] {
    return this.sent.filter((event) => ITEM_KEY in event.content && !("m.relates_to" in event.content));
  }

  edits(): MatrixEvent[] {
    return this.sent.filter((event) => "m.new_content" in event.content);
  }

  failNextSends(count: number): void {
    this.failSends = count;
  }

  failNextSyncs(count: number): void {
    this.failSyncs = count;
  }

  /** Queues one /sync batch; its `since` is "s<n>". */
  deliver(...events: MatrixEvent[]): SyncBatch {
    const batch = { since: `s${this.batches.length + 1}`, events, limited: false };
    this.batches.push(batch);
    for (const wake of [...this.waiters]) wake();
    return batch;
  }

  async *syncLoop({ since, signal }: SyncOptions = {}): AsyncGenerator<SyncBatch> {
    let next = since === undefined ? 0 : Number(since.slice(1));
    while (!signal?.aborted) {
      if (this.failSyncs > 0 && this.failSyncs--) throw new Error("sync failed");
      const batch = this.batches[next];
      if (batch) {
        next += 1;
        yield batch;
      } else await this.nextBatch(signal);
    }
  }

  private nextBatch(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const done = () => {
        this.waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      this.waiters.add(done);
      signal?.addEventListener("abort", done);
    });
  }
}
