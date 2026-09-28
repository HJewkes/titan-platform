import type { MirrorLogger } from "./types.js";

export interface Backoff {
  initialMs: number;
  maxMs: number;
}

export interface SuperviseOptions {
  signal: AbortSignal;
  backoff: Backoff;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  logger: MirrorLogger;
}

export const DEFAULT_BACKOFF: Backoff = { initialMs: 1_000, maxMs: 60_000 };

/** Reruns `body` after each throw with doubling delay; `reset` restores the initial delay after progress. */
export async function superviseLoop(name: string, body: (reset: () => void) => Promise<void>, options: SuperviseOptions): Promise<void> {
  const { signal, backoff, sleep, logger } = options;
  let delay = backoff.initialMs;
  const reset = () => {
    delay = backoff.initialMs;
  };
  while (!signal.aborted) {
    try {
      return await body(reset);
    } catch (err) {
      if (signal.aborted) return;
      logger.warn(`${name} failed`, { error: err instanceof Error ? err.message : String(err), retryInMs: delay });
      await sleep(delay, signal);
      delay = Math.min(delay * 2, backoff.maxMs);
    }
  }
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}
