export interface SseMessage {
  event: string;
  data: string;
}

export type Subscriber = (message: SseMessage) => void | Promise<void>;

/** Transport-agnostic fan-out: `/events` subscribes each SSE stream, the daemon broadcasts. */
export class EventHub {
  private readonly subscribers = new Set<Subscriber>();

  /** Register a subscriber; returns an unsubscribe function. */
  subscribe(send: Subscriber): () => void {
    this.subscribers.add(send);
    return () => {
      this.subscribers.delete(send);
    };
  }

  get size(): number {
    return this.subscribers.size;
  }

  /**
   * Push a message to every subscriber. A slow or broken subscriber never blocks the
   * others and never throws out of `broadcast`; failures drop that subscriber so a dead
   * connection cannot wedge future broadcasts.
   */
  broadcast(message: SseMessage): void {
    for (const send of this.subscribers) {
      try {
        const result = send(message);
        if (result && typeof result.then === "function") {
          result.catch(() => this.subscribers.delete(send));
        }
      } catch {
        this.subscribers.delete(send);
      }
    }
  }
}
