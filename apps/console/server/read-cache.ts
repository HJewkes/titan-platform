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

export function cachedRead<T>(load: () => Promise<T>, { freshMs, staleMs }: CacheTimes, now: () => number = Date.now): CachedRead<T> {
  let kept: { at: number; value: T } | undefined;
  let running: Promise<T> | undefined;
  let generation = 0;
  function refresh(): Promise<T> {
    if (running !== undefined) return running;
    const started = { at: now(), generation };
    const run = load().then((value) => {
      if (started.generation === generation) kept = { at: started.at, value };
      return value;
    });
    running = run;
    void run.finally(() => {
      if (running === run) running = undefined;
    }).catch(() => undefined);
    return run;
  }
  return {
    read() {
      const age = kept === undefined ? Infinity : now() - kept.at;
      if (age >= staleMs) return refresh();
      if (age >= freshMs) refresh().catch(() => undefined);
      return Promise.resolve(kept!.value);
    },
    invalidate() {
      kept = undefined;
      running = undefined;
      generation += 1;
    },
  };
}
