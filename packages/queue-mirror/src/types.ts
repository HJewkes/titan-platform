import type { ItemKind, TitanItem, Verdict } from "@titan-design/matrix-bus";

/** One pending thing a human can act on; `id` becomes TitanItem.msg_id. */
export interface QueueItem {
  id: string;
  kind: ItemKind;
  machine: string;
  session: string;
  at: number;
  agentId?: string;
  toolName?: string;
  inputPreview?: string;
  recipient?: string;
  text?: string;
  /** Epoch ms; the mirror edits the item "expired" once the clock passes it. */
  expiresAt?: number;
}

export type CloseOutcome = "resolved" | "cancelled" | "expired";

export type SourceEvent =
  | { type: "opened"; item: QueueItem; cursor: string }
  | { type: "closed"; id: string; outcome: CloseOutcome; label?: string; cursor: string };

export interface VerdictInput {
  verdict: Verdict;
  text?: string;
  resolutionEventId: string;
}

export type ResolveResult = { ok: true } | { ok: false; reason: "closed" | "rejected"; detail?: string };

export interface QueueSource {
  readonly kinds: readonly ItemKind[];
  open(): Promise<QueueItem[]>;
  /** Events after `cursor` (undefined = from now); ends when `signal` aborts. */
  tail(cursor: string | undefined, signal: AbortSignal): AsyncIterable<SourceEvent>;
  resolve(id: string, verdict: VerdictInput): Promise<ResolveResult>;
}

export interface PostedItem {
  sourceId: string;
  eventId: string;
  kind: ItemKind;
  /** False when the item was redacted or truncated, so no phone verdict may resolve it. */
  approvable: boolean;
  status: "open" | "closed";
  /** Epoch ms after which the sweep closes the item: the source's expiry, or the approval TTL. */
  expiresAt?: number;
  /** The record as posted; an edit repeats it in m.new_content and reads its redacted and truncated flags. */
  record: TitanItem;
}

export interface StateChange {
  sourceCursor?: string;
  syncToken?: string;
  posted?: PostedItem[];
  /** Source ids. */
  closed?: string[];
  /** Resolution event ids. */
  applied?: string[];
}

/** Synchronous like hitl's GateStore: both implementations are local. `commit` is atomic. */
export interface MirrorState {
  sourceCursor(): string | undefined;
  syncToken(): string | undefined;
  bySourceId(id: string): PostedItem | undefined;
  byEventId(eventId: string): PostedItem | undefined;
  openItems(): PostedItem[];
  hasApplied(resolutionEventId: string): boolean;
  commit(change: StateChange): void;
}
