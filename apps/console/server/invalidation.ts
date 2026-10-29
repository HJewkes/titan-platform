import type { RelaySource } from "./events-relay.js";

/** Lets a cache hear that an upstream moved, from the events relay that watches it, and say when it has caught up. */
export interface Invalidation {
  on(source: RelaySource, listener: () => void): void;
  emit(source: RelaySource): void;
  /** A cache that served a moved value has now read the new one, so a page that read the old one can read again. */
  onRefreshed(source: RelaySource, listener: () => void): void;
  refreshed(source: RelaySource): void;
}

function channel(): { on(source: RelaySource, listener: () => void): void; emit(source: RelaySource): void } {
  const listeners = new Map<RelaySource, Array<() => void>>();
  return {
    on: (source, listener) => void listeners.set(source, [...(listeners.get(source) ?? []), listener]),
    emit: (source) => {
      for (const listener of listeners.get(source) ?? []) listener();
    },
  };
}

export function createInvalidation(): Invalidation {
  const moved = channel();
  const caughtUp = channel();
  return { on: moved.on, emit: moved.emit, onRefreshed: caughtUp.on, refreshed: caughtUp.emit };
}
