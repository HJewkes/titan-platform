import type { RelaySource } from "./events-relay.js";

/** Lets a cache hear that an upstream moved, from the events relay that watches it. */
export interface Invalidation {
  on(source: RelaySource, listener: () => void): void;
  emit(source: RelaySource): void;
}

export function createInvalidation(): Invalidation {
  const listeners = new Map<RelaySource, Array<() => void>>();
  return {
    on: (source, listener) => void listeners.set(source, [...(listeners.get(source) ?? []), listener]),
    emit: (source) => {
      for (const listener of listeners.get(source) ?? []) listener();
    },
  };
}
