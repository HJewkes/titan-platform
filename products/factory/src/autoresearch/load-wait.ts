import { loadavg } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

export interface LoadWaitOptions {
  /** A stage starts only while the five-minute load is strictly below this. */
  ceiling: number;
  pollMs: number;
  /** A stage still held this long after its step first started fails instead of waiting on; absent, it waits indefinitely. */
  maxWaitMs?: number;
  /** Lifted from the shepherd spawn gate's read, not imported: that gate is on the old path. */
  readLoad5?: () => number;
  now?: () => number;
}

/**
 * G9: holds a stage until machine load falls, and reports how long it held and the load it started at. The wait
 * counts from the step's first start, so a restart neither resets the deadline nor under-reports the wait.
 */
export function loadWaitPort(options: LoadWaitOptions) {
  const readLoad5 = options.readLoad5 ?? (() => loadavg()[1] ?? 0);
  const now = options.now ?? Date.now;
  return async (input: { stage: string; firstStartedAt?: string }, signal: AbortSignal): Promise<{ waitedMs: number; load5: number }> => {
    const recorded = input.firstStartedAt === undefined ? NaN : Date.parse(input.firstStartedAt);
    const start = Number.isFinite(recorded) ? recorded : now();
    for (;;) {
      signal.throwIfAborted();
      const load5 = readLoad5();
      const waitedMs = Math.max(0, now() - start);
      if (load5 < options.ceiling) return { waitedMs, load5 };
      if (options.maxWaitMs !== undefined && waitedMs >= options.maxWaitMs) {
        throw new Error(`[load-timeout] ${input.stage} held ${waitedMs} ms with load ${load5} at or above ${options.ceiling}`);
      }
      await sleep(options.pollMs, undefined, { signal });
    }
  };
}

/**
 * Lanes of one round start one at a time until the first has answered, so the rest read its prompt prefix from cache.
 * The first caller of a round opens the latch; the others wait on it. `alreadyStarted` lets a restarted host skip the wait
 * when the roster shows the round was under way before it.
 */
export function staggerLatch(alreadyStarted: (round: number) => Promise<boolean>) {
  const opened = new Map<number, Promise<void>>();
  return async <T>(round: number, start: (responded: () => void) => Promise<T>): Promise<T> => {
    const prior = opened.get(round);
    if (prior !== undefined) {
      await prior;
      return start(() => undefined);
    }
    let open!: () => void;
    opened.set(round, new Promise<void>((resolve) => (open = resolve)));
    if (await alreadyStarted(round)) open();
    try {
      return await start(open);
    } finally {
      open();
    }
  };
}
