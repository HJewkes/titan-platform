interface CachedProbeOptions<P> {
  now: () => number;
  ttlMs: number;
  /** What `status` answers before the first probe lands. */
  pending: P;
}

export interface CachedProbe<T, P> {
  /** The last probe result, or `pending` before the first lands; starts a background refresh and never waits on it. */
  status(): T | P;
  /** Probe now unless one is in flight or the last result is still fresh. */
  refresh(): Promise<void>;
}

/** /health is synchronous, so it reports the last result of a slow probe and refreshes it in the background at most once per ttl. */
export function cachedProbe<T, P>(probe: () => Promise<T>, { now, ttlMs, pending }: CachedProbeOptions<P>): CachedProbe<T, P> {
  let last: { value: T; at: number } | undefined;
  let inFlight: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    if (inFlight || (last && now() - last.at < ttlMs)) return inFlight ?? Promise.resolve();
    inFlight = probe()
      .then((value) => void (last = { value, at: now() }))
      .finally(() => (inFlight = null));
    return inFlight;
  };
  return {
    status: () => {
      void refresh();
      return last ? last.value : pending;
    },
    refresh,
  };
}
