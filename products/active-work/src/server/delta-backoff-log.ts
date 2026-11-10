import type { PassKind } from "../session-index/scheduler.js";

interface WatchLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

type Run<T> = (
  kind: PassKind,
  onIndexed: () => void,
  onLockWait: (waiting: boolean) => void
) => Promise<T>;

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

/** Passed to the scheduler so its backoff and the logged `backoffMs` come from one pair of numbers. */
export const BACKOFF_OPTIONS = {
  baseBackoffMs: BASE_BACKOFF_MS,
  maxBackoffMs: MAX_BACKOFF_MS,
};

function backoffAfter(failures: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
}

/**
 * Logs a failing delta once when its backoff starts and once when a pass next
 * succeeds. The scheduler answers readers stale while the backoff runs, so a
 * reader adds nothing worth a line of its own (TP-1014). Full-pass failures
 * keep their own warning.
 */
export function deltaBackoffLog(
  log: WatchLogger,
  signal: AbortSignal
): { wrap<T>(run: Run<T>): Run<T>; onError(err: unknown): void } {
  let failures = 0;
  let failedKind: PassKind | null = null;
  return {
    wrap: (run) => async (kind, onIndexed, onLockWait) => {
      try {
        const result = await run(kind, onIndexed, onLockWait);
        if (failures > 0) log.info({}, "session index delta recovered");
        failures = 0;
        return result;
      } catch (err) {
        failedKind = kind;
        throw err;
      }
    },
    onError: (err) => {
      if (signal.aborted) return;
      if (failedKind !== "delta")
        return log.warn({ err }, "session index refresh failed");
      failures += 1;
      log.warn(
        { err, backoffMs: backoffAfter(failures) },
        "session index delta failed; backing off"
      );
    },
  };
}
