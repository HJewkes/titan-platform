/**
 * A stale-while-revalidate read for an upstream slower than the page waiting on it (TP-4390: the factory's needs.list
 * takes seconds). A value younger than `freshMs` is served as is; one younger than `staleMs` is served while a single
 * refresh runs behind it; anything older, or nothing, waits for the read. A failed read is never kept, so the caller sees
 * the failure once the kept value is too old to serve.
 */
export interface CachedRead<T> {
  read(): Promise<T>;
  /** After a write the kept value may be wrong, so the next read waits for a fresh one; a read already running is dropped. */
  invalidate(): void;
}

export interface CacheTimes {
  freshMs: number;
  staleMs: number;
}

interface CacheState<T> {
  kept?: { at: number; value: T };
  running?: Promise<T>;
  /** Bumped by each invalidate, so a read started before it is returned to its caller but never kept. */
  generation: number;
}

/** One read at a time; callers that arrive while it runs share it. */
function refresh<T>(state: CacheState<T>, load: () => Promise<T>, now: () => number): Promise<T> {
  if (state.running !== undefined) return state.running;
  const started = { at: now(), generation: state.generation };
  const run = load().then((value) => {
    if (started.generation === state.generation) state.kept = { at: started.at, value };
    return value;
  });
  const settled = () => {
    if (state.running === run) state.running = undefined;
  };
  state.running = run;
  run.then(settled, settled);
  return run;
}

export function cachedRead<T>(load: () => Promise<T>, { freshMs, staleMs }: CacheTimes, now: () => number = Date.now): CachedRead<T> {
  const state: CacheState<T> = { generation: 0 };
  return {
    read() {
      const { kept } = state;
      const age = kept === undefined ? Infinity : now() - kept.at;
      if (kept === undefined || age >= staleMs) return refresh(state, load, now);
      if (age >= freshMs) refresh(state, load, now).catch(() => undefined);
      return Promise.resolve(kept.value);
    },
    invalidate() {
      state.kept = undefined;
      state.running = undefined;
      state.generation += 1;
    },
  };
}

export interface CachedReads<A, T> {
  read(args: A): Promise<T>;
  /** Drops every key, so each next read waits for a fresh one; reads already running are returned to their callers but never kept. */
  invalidate(): void;
}

export interface KeyedOptions<A> {
  /** Two arguments with the same key share one kept value and one running read. */
  keyOf(args: A): string;
  /** The least recently read key goes first once more are kept. */
  maxKeys: number;
  now?: () => number;
}

/** `cachedRead` for a read that takes arguments: each key has its own value, and all keys share the times. */
export function cachedReads<A, T>(load: (args: A) => Promise<T>, times: CacheTimes, { keyOf, maxKeys, now = Date.now }: KeyedOptions<A>): CachedReads<A, T> {
  let entries = new Map<string, CachedRead<T>>();
  return {
    read(args) {
      const key = keyOf(args);
      const entry = entries.get(key) ?? cachedRead(() => load(args), times, now);
      entries.delete(key);
      entries.set(key, entry);
      for (const oldest of entries.keys()) {
        if (entries.size <= maxKeys) break;
        entries.delete(oldest);
      }
      return entry.read();
    },
    invalidate() {
      for (const entry of entries.values()) entry.invalidate();
      entries = new Map();
    },
  };
}

/** JSON with object keys sorted, so `{a, b}` and `{b, a}` name one read. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
      : inner,
  );
}
