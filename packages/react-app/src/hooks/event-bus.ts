import type { SseMessage } from "@titan-design/rpc-protocol";
import type { DataSource, LiveStatus, Subscription } from "@titan-design/rpc-client";

/** One shared event stream per provider, opened by the first listener and closed after the last. */
export interface EventBus {
  listen(onEvent: (message: SseMessage) => void): () => void;
  watchStatus(listener: () => void): () => void;
  status(): LiveStatus;
}

export function createEventBus(source: DataSource): EventBus {
  const eventListeners = new Set<(message: SseMessage) => void>();
  const statusListeners = new Set<() => void>();
  let status: LiveStatus = "closed";
  let subscription: Subscription | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const setStatus = (next: LiveStatus): void => {
    status = next;
    for (const listener of [...statusListeners]) listener();
  };

  const open = (): void => {
    clearTimeout(closeTimer);
    if (subscription) return;
    setStatus("connecting");
    subscription = source.subscribe({
      onEvent: (message) => {
        for (const listener of [...eventListeners]) listener(message);
      },
      onStatus: setStatus,
    });
  };

  // Deferred a tick so a StrictMode unmount-remount keeps the stream rather than redialling it.
  const closeIfIdle = (): void => {
    if (eventListeners.size + statusListeners.size > 0) return;
    closeTimer = setTimeout(() => {
      subscription?.close();
      subscription = undefined;
      status = "closed";
    }, 0);
  };

  const join = <T>(set: Set<T>, item: T): (() => void) => {
    set.add(item);
    open();
    return () => {
      set.delete(item);
      closeIfIdle();
    };
  };

  return {
    listen: (onEvent) => join(eventListeners, onEvent),
    watchStatus: (listener) => join(statusListeners, listener),
    status: () => status,
  };
}
