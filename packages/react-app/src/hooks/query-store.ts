import { EXIT, type JsonEnvelope } from "@titan-design/rpc-protocol";
import { RpcError, snapshotKey, type DataSource } from "@titan-design/rpc-client";

export type QueryStatus = "loading" | "success" | "error";

interface QueryFetchState {
  /** True while a call is in flight, including a refetch that keeps the previous data. */
  isFetching: boolean;
}

/** A failed refetch keeps the last good data beside the error. */
export type QueryState<R = unknown> = QueryFetchState &
  (
    | { status: "loading"; data: undefined; error: undefined }
    | { status: "success"; data: R; error: undefined }
    | { status: "error"; data: R | undefined; error: RpcError }
  );

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

export interface QueryStoreOptions {
  /** How long an unwatched query keeps its result for a later watcher; 0 drops it a tick after the last unwatch. */
  gcMs?: number;
  /** Told once per call that finishes without being superseded or aborted; a throwing observer cannot break a query. */
  onSettle?: (settled: QuerySettled) => void;
  /** Milliseconds clock for `onSettle`'s `ms`; injectable for tests. */
  now?: () => number;
}

/** What `onSettle` learns about one call. It carries the command name only, never its arguments or result. */
export interface QuerySettled {
  command: string;
  /** Elapsed time from the call's start to its answer. */
  ms: number;
  ok: boolean;
  /** True when the entry already held data as the call began, so the user saw that data while this call ran. */
  fromCache: boolean;
}

export function createQueryStore(source: DataSource, { gcMs = 0, onSettle, now = () => performance.now() }: QueryStoreOptions = {}): QueryStore {
  const entries = new Map<string, Entry>();

  const run = (entry: Entry): void => {
    entry.controller?.abort();
    const controller = new AbortController();
    entry.controller = controller;
    const started = now();
    const fromCache = entry.state.data !== undefined;
    if (!entry.state.isFetching) update(entry, { ...entry.state, isFetching: true });
    const done = (envelope: JsonEnvelope<unknown>): void => {
      if (!settle(entry, controller, envelope)) return;
      observe(onSettle, { command: entry.command, ms: now() - started, ok: envelope.ok, fromCache });
    };
    source.call(entry.command, entry.args, { signal: controller.signal }).then(done, (err: unknown) => done(rejection(entry.command, err)));
  };

  const drop = (key: string, entry: Entry): void => {
    clearTimeout(entry.dropTimer);
    entry.controller?.abort();
    // A newer entry may own the key by now; only delete the one this drop was armed for.
    if (entries.get(key) === entry) entries.delete(key);
  };

  return {
    watch(command, args, listener) {
      const key = snapshotKey(command, args);
      const entry = entries.get(key) ?? adopt(entries, key, command, args, run);
      const kept = entry.dropTimer !== undefined;
      clearTimeout(entry.dropTimer);
      entry.dropTimer = undefined;
      entry.listeners.add(listener);
      // A kept entry shows its old data at once; the refetch runs behind it.
      if (kept && gcMs > 0 && !entry.controller) run(entry);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size > 0) return;
        // gcMs 0 defers a tick so a StrictMode unmount-remount keeps the in-flight call instead of redialling.
        entry.dropTimer = setTimeout(() => drop(key, entry), gcMs);
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

/** Returns false for a stale answer, which changes nothing. */
function settle(entry: Entry, controller: AbortController, envelope: JsonEnvelope<unknown>): boolean {
  // Every newer call and every drop aborts this controller first, so an aborted answer is a stale one.
  if (controller.signal.aborted) return false;
  entry.controller = undefined;
  if (envelope.ok) {
    update(entry, { status: "success", data: envelope.data, error: undefined, isFetching: false });
    return true;
  }
  const error = new RpcError(entry.command, envelope.error, envelope.code);
  update(entry, { status: "error", data: entry.state.data, error, isFetching: false });
  return true;
}

function observe(onSettle: ((settled: QuerySettled) => void) | undefined, settled: QuerySettled): void {
  try {
    onSettle?.(settled);
  } catch {
    // Telemetry must never fail a query.
  }
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
