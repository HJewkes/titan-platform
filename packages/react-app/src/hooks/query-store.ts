import { EXIT, type JsonEnvelope } from "@titan-design/rpc-protocol";
import { RpcError, snapshotKey, type DataSource } from "@titan-design/rpc-client";

export type QueryStatus = "loading" | "success" | "error";

export interface QueryState {
  status: QueryStatus;
  data: unknown;
  error: RpcError | undefined;
  /** True while a call is in flight, including a refetch that keeps the previous data. */
  isFetching: boolean;
}

export const LOADING: QueryState = Object.freeze({ status: "loading", data: undefined, error: undefined, isFetching: true });

interface Entry {
  command: string;
  args: unknown;
  state: QueryState;
  listeners: Set<() => void>;
  controller: AbortController | undefined;
  dropTimer: ReturnType<typeof setTimeout> | undefined;
}

/** Framework-free cache of command results, keyed by `snapshotKey(command, args)`. */
export interface QueryStore {
  /** Watches one query; the first watcher of a key starts its call, the last one's leaving aborts it. */
  watch(command: string, args: unknown, listener: () => void): () => void;
  state(key: string): QueryState;
  refetch(key: string): void;
  /** Refetches watched queries for the named commands, or all of them when none are named. */
  invalidate(commands?: readonly string[]): void;
}

export function createQueryStore(source: DataSource): QueryStore {
  const entries = new Map<string, Entry>();

  const run = (entry: Entry): void => {
    entry.controller?.abort();
    const controller = new AbortController();
    entry.controller = controller;
    if (!entry.state.isFetching) update(entry, { ...entry.state, isFetching: true });
    source.call(entry.command, entry.args, { signal: controller.signal }).then(
      (envelope) => settle(entry, controller, envelope),
      (err: unknown) => settle(entry, controller, rejection(entry.command, err)),
    );
  };

  const drop = (key: string, entry: Entry): void => {
    entry.controller?.abort();
    entries.delete(key);
  };

  return {
    watch(command, args, listener) {
      const key = snapshotKey(command, args);
      const entry = entries.get(key) ?? adopt(entries, key, command, args, run);
      clearTimeout(entry.dropTimer);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size > 0) return;
        // Deferred a tick so a StrictMode unmount-remount keeps the in-flight call instead of redialling.
        entry.dropTimer = setTimeout(() => drop(key, entry), 0);
      };
    },
    state: (key) => entries.get(key)?.state ?? LOADING,
    refetch(key) {
      const entry = entries.get(key);
      if (entry) run(entry);
    },
    invalidate(commands) {
      for (const [key, entry] of entries) {
        if (commands && !commands.includes(entry.command)) continue;
        if (entry.listeners.size === 0) drop(key, entry);
        else run(entry);
      }
    },
  };
}

function adopt(entries: Map<string, Entry>, key: string, command: string, args: unknown, run: (entry: Entry) => void): Entry {
  const entry: Entry = { command, args, state: LOADING, listeners: new Set(), controller: undefined, dropTimer: undefined };
  entries.set(key, entry);
  run(entry);
  return entry;
}

function settle(entry: Entry, controller: AbortController, envelope: JsonEnvelope<unknown>): void {
  // Every newer call and every drop aborts this controller first, so an aborted answer is a stale one.
  if (controller.signal.aborted) return;
  entry.controller = undefined;
  if (envelope.ok) {
    update(entry, { status: "success", data: envelope.data, error: undefined, isFetching: false });
    return;
  }
  const error = new RpcError(entry.command, envelope.error, envelope.code);
  update(entry, { status: "error", data: entry.state.data, error, isFetching: false });
}

/** A source rejects only on abort, which `settle` ignores; anything else broke that contract. */
function rejection(command: string, err: unknown): JsonEnvelope<unknown> {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: `${command} failed in its data source: ${message}`, code: EXIT.SOFTWARE };
}

function update(entry: Entry, next: QueryState): void {
  entry.state = next;
  for (const listener of [...entry.listeners]) listener();
}
