import { ITEM_KEY, encodeItem, foldResolution, type AppserviceClient, type ItemKind, type MatrixEvent, type Resolution, type SyncBatch } from "@titan-design/matrix-bus";
import { encodeEdit } from "./edit.js";
import { toItemInput } from "./render.js";
import type { Backoff } from "./supervise.js";
import type { MirrorLogger, MirrorState, PostedItem, QueueItem, QueueSource, ResolveResult, SourceEvent, VerdictInput } from "./types.js";

/** The slice of AppserviceClient the mirror drives; tests pass a fake hub. */
export type MirrorBus = Pick<AppserviceClient, "send" | "syncLoop" | "userId">;

export interface MirrorOptions {
  ownerUserId: string;
  roomId: string;
  signal: AbortSignal;
  now?: () => number;
  /** Default expiry for approval_request items lacking expiresAt. */
  approvalTtlMs?: number;
  sweepIntervalMs?: number;
  syncTimeoutMs?: number;
  backoff?: Backoff;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  logger?: MirrorLogger;
}

/** Steps exposed so tests drive the mirror deterministically; runMirror only loops over them. */
export interface Mirror {
  reconcile(): Promise<void>;
  applySourceEvent(event: SourceEvent): Promise<void>;
  applySyncBatch(batch: SyncBatch): Promise<void>;
  sweepExpired(): Promise<void>;
}

export const SILENT: MirrorLogger = { info: () => {}, warn: () => {} };

// Deterministic, so a re-send after a crash between send and commit is deduped by the homeserver.
const itemTxnId = (sourceId: string) => `qm-${encodeURIComponent(sourceId)}`;
const editTxnId = (sourceId: string) => `qm-edit-${encodeURIComponent(sourceId)}`;
// Distinct from editTxnId, which the final close edit must still be free to use.
const rejectTxnId = (sourceId: string, resolutionEventId: string) =>
  `qm-reject-${encodeURIComponent(sourceId)}-${encodeURIComponent(resolutionEventId)}`;

function closedStatus(event: Extract<SourceEvent, { type: "closed" }>): string {
  if (event.outcome === "resolved") return event.label ? `resolved at the terminal: ${event.label}` : "resolved at the terminal";
  return event.outcome;
}

class QueueMirror implements Mirror {
  private readonly log: MirrorLogger;
  private readonly now: () => number;
  /** Source ids with a phone verdict in flight; their echoed source close must not win the edit. */
  private readonly resolving = new Set<string>();

  constructor(
    private readonly source: QueueSource,
    private readonly bus: MirrorBus,
    private readonly state: MirrorState,
    private readonly options: MirrorOptions,
  ) {
    this.log = options.logger ?? SILENT;
    this.now = options.now ?? Date.now;
  }

  async reconcile(): Promise<void> {
    const pending = await this.source.open();
    const pendingIds = new Set(pending.map((item) => item.id));
    for (const item of this.state.openItems()) {
      if (!pendingIds.has(item.sourceId) && !this.resolving.has(item.sourceId)) await this.close(item, "resolved at the terminal");
    }
    for (const item of pending) if (!this.state.bySourceId(item.id)) await this.post(item);
  }

  async applySourceEvent(event: SourceEvent): Promise<void> {
    const cursor = event.cursor;
    if (event.type === "resync") {
      await this.reconcile();
      return this.state.commit({ sourceCursor: cursor });
    }
    if (event.type === "opened") {
      if (this.state.bySourceId(event.item.id)) return this.state.commit({ sourceCursor: cursor });
      return this.post(event.item, cursor);
    }
    const item = this.state.bySourceId(event.id);
    if (item?.status !== "open" || this.resolving.has(event.id)) return this.state.commit({ sourceCursor: cursor });
    await this.close(item, closedStatus(event), { sourceCursor: cursor });
  }

  /** Persists `since` only after every event is handled; a throw leaves it for the retry. */
  async applySyncBatch(batch: SyncBatch): Promise<void> {
    for (const event of batch.events) await this.applyEvent(event);
    this.state.commit({ syncToken: batch.since });
  }

  async sweepExpired(): Promise<void> {
    const now = this.now();
    for (const item of this.state.openItems()) {
      if (item.expiresAt !== undefined && item.expiresAt <= now) await this.close(item, "expired");
    }
  }

  private expiryOf(item: QueueItem): number | undefined {
    if (item.expiresAt !== undefined) return item.expiresAt;
    const ttl = this.options.approvalTtlMs;
    return item.kind === "approval_request" && ttl !== undefined ? item.at + ttl : undefined;
  }

  private async post(item: QueueItem, sourceCursor?: string): Promise<void> {
    const input = toItemInput(item);
    const content = encodeItem(input);
    const { event_id: eventId } = await this.bus.send(this.options.roomId, "m.room.message", content, itemTxnId(item.id));
    const posted: PostedItem = {
      sourceId: item.id,
      eventId,
      kind: item.kind,
      approvable: !input.redacted && !input.truncated,
      status: "open",
      expiresAt: this.expiryOf(item),
      record: content[ITEM_KEY],
    };
    this.state.commit({ posted: [posted], sourceCursor });
    this.log.info("posted", { sourceId: item.id, eventId });
  }

  /** Edits first, then commits, so a crash in between replays into the same deduped edit. */
  private async close(item: PostedItem, status: string, change: { sourceCursor?: string; applied?: string[] } = {}): Promise<void> {
    const edit = encodeEdit(item.eventId, item.record, status);
    await this.bus.send(this.options.roomId, "m.room.message", edit, editTxnId(item.sourceId));
    this.state.commit({ ...change, closed: [item.sourceId] });
    this.log.info("closed", { sourceId: item.sourceId, status });
  }

  private async applyEvent(event: MatrixEvent): Promise<void> {
    if (event.sender === this.bus.userId || this.state.hasApplied(event.event_id)) return;
    const open = this.state.openItems();
    const resolution = this.fold(event, open.filter((item) => item.approvable));
    if (resolution) return this.applyResolution(event, resolution);
    const refused = this.fold(event, open.filter((item) => !item.approvable));
    if (refused) return this.logRefusal(event, refused);
    if (isResolutionShaped(event)) this.log.info("ignored", { eventId: event.event_id, sender: event.sender });
  }

  private fold(event: MatrixEvent, items: PostedItem[]): Resolution | null {
    const itemEventIds = new Map<string, ItemKind>(items.map((item) => [item.eventId, item.kind]));
    return foldResolution(event, { ownerUserId: this.options.ownerUserId, itemEventIds });
  }

  private logRefusal(event: MatrixEvent, refused: Resolution): void {
    const item = this.state.byEventId(refused.itemEventId);
    const reason = item?.record.truncated ? "truncated" : "redacted";
    this.log.warn(`refused: ${reason}`, { eventId: event.event_id, sourceId: item?.sourceId });
  }

  private async applyResolution(event: MatrixEvent, { itemEventId, verdict, text }: Resolution): Promise<void> {
    const item = this.state.byEventId(itemEventId) as PostedItem;
    const applied = [event.event_id];
    const result = await this.resolveAtSource(item.sourceId, { verdict, text, resolutionEventId: event.event_id });
    if (result.ok) return this.close(item, `resolved: ${verdict}`, { applied });
    if (result.reason === "closed") return this.close(item, "already resolved", { applied });
    await this.markRefused(item, event.event_id, result.detail);
    this.log.warn("rejected", { sourceId: item.sourceId, verdict, detail: result.detail });
  }

  /** Edits the status but leaves the item open, so the owner can still answer it. */
  private async markRefused(item: PostedItem, resolutionEventId: string, detail = "rejected"): Promise<void> {
    const edit = encodeEdit(item.eventId, item.record, `refused: ${detail}`);
    await this.bus.send(this.options.roomId, "m.room.message", edit, rejectTxnId(item.sourceId, resolutionEventId));
    this.state.commit({ applied: [resolutionEventId] });
  }

  private async resolveAtSource(sourceId: string, verdict: VerdictInput): Promise<ResolveResult> {
    this.resolving.add(sourceId);
    try {
      return await this.source.resolve(sourceId, verdict);
    } finally {
      this.resolving.delete(sourceId);
    }
  }
}

const RESOLUTION_TYPES = new Set(["m.reaction", "m.room.message", "io.titan.resolution"]);

function isResolutionShaped(event: MatrixEvent): boolean {
  return RESOLUTION_TYPES.has(event.type) && event.state_key === undefined;
}

export function createMirror(source: QueueSource, bus: MirrorBus, state: MirrorState, options: MirrorOptions): Mirror {
  return new QueueMirror(source, bus, state, options);
}
