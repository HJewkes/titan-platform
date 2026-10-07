import type { ItemStatus, OwnerAnswer, OwnerItem, SourceRef } from "./schema.js";

export type ClosedStatus = Exclude<ItemStatus, "open">;

export type SourceEvent =
  | { type: "opened"; item: OwnerItem; cursor: string }
  | { type: "closed"; ref: string; status: ClosedStatus; cursor: string }
  /** The source lost its place (a gap too large to replay); the reader re-reads open(). */
  | { type: "resync"; cursor: string };

export type ResolveResult = { ok: true } | { ok: false; reason: "closed" | "rejected"; detail?: string };

/** One store of record behind the owner queue. Adapters own all I/O; every item they emit names this source in `sources`. */
export interface QueueSource {
  readonly system: SourceRef["system"];
  open(): Promise<OwnerItem[]>;
  /** Events after `cursor` (undefined = from now); ends when `signal` aborts. */
  tail(cursor: string | undefined, signal: AbortSignal): AsyncIterable<SourceEvent>;
  /** `ref` is the source's own SourceRef.ref; the store of record arbitrates, so a second answer loses. */
  resolve(ref: string, answer: OwnerAnswer): Promise<ResolveResult>;
}
