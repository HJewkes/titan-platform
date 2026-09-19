import type { JsonEnvelope, SseMessage } from "@titan-design/rpc-protocol";

export interface CallOptions {
  signal?: AbortSignal;
}

/** `connecting` covers the first dial and every reconnect; `closed` is final. */
export type LiveStatus = "connecting" | "open" | "closed";

export interface EventHandlers {
  /** Product broadcasts only; the reserved `ready` and `ping` frames never reach here. */
  onEvent(message: SseMessage): void;
  onStatus?(status: LiveStatus): void;
}

export interface Subscription {
  close(): void;
}

/**
 * Where a client's answers come from. The contract is untyped on purpose: a source moves
 * envelopes, and `createRpcClient<M>` adds the command types on top.
 */
export interface DataSource {
  /** Resolves to an envelope for every outcome, failures included; rejects only when aborted. */
  call(name: string, args: unknown, options?: CallOptions): Promise<JsonEnvelope<unknown>>;
  subscribe(handlers: EventHandlers, options?: CallOptions): Subscription;
}
