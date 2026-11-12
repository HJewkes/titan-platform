import type { PassFailure, PassKind } from "../session-index/scheduler.js";

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

/** Passed to the scheduler, which owns the backoff and reports it to `onError`. */
export const BACKOFF_OPTIONS = {
  baseBackoffMs: BASE_BACKOFF_MS,
  maxBackoffMs: MAX_BACKOFF_MS,
};

/**
 * Logs a failing delta once when its backoff starts and once when a pass next
 * succeeds. The scheduler answers readers stale while the backoff runs, so a
 * reader adds nothing worth a line of its own (TP-1014). Full-pass failures
 * keep their own warning.
 */
export function deltaBackoffLog(
  log: WatchLogger,
  signal: AbortSignal
): { wrap<T>(run: Run<T>): Run<T>; onError(err: unknown, failure: PassFailure): void } {
  let deltaFailing = false;
  return {
    wrap: (run) => async (kind, onIndexed, onLockWait) => {
      const result = await run(kind, onIndexed, onLockWait);
      if (deltaFailing) log.info({}, "session index delta recovered");
      deltaFailing = false;
      return result;
    },
    onError: (err, { kind, backoffMs }) => {
      if (signal.aborted) return;
      if (kind !== "delta")
        return log.warn({ err }, "session index refresh failed");
      deltaFailing = true;
      log.warn(
        { err, backoffMs },
        "session index delta failed; backing off"
      );
    },
  };
}
