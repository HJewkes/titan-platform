/**
 * The session index watcher's outside work, injectable so its tests can drive a pass
 * without the real refresh, the sysctl pressure probe or the daemon's reader gate.
 */
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { readerGate, type ReaderGate } from '../session-index/reader-gate.js';
import { runRefresh, type RefreshOptions, type RefreshSummary } from '../session-index/refresh.js';
import { readMachinePressure, type MachinePressure } from '../utils/machine-pressure.js';

/** The watcher's outside work: the refresh pass, the machine-pressure probe and the reader gate. */
export interface WatchDeps {
  refresh: (options: RefreshOptions) => Promise<RefreshSummary>;
  readPressure: () => Promise<MachinePressure | null>;
  gate: Pick<ReaderGate, 'idle'>;
}

export const WATCH_DEPS: WatchDeps = {
  refresh: runRefresh,
  readPressure: () => readMachinePressure(),
  gate: readerGate,
};

/** The longest a pass waits on in-flight related requests before it resumes anyway. */
const IDLE_CAP_MS = 5_000;

/** Settles with `work`, or rejects with the abort reason as soon as `signal` fires. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * The daemon pass's yield point: let I/O in, then hold while a related request runs (TP-343).
 * An aborted `signal` ends the pass here, between chunks, so shutdown loses nothing committed (TP-791).
 */
export async function yieldToReaders(
  signal?: AbortSignal,
  gate: Pick<ReaderGate, 'idle'> = WATCH_DEPS.gate,
): Promise<void> {
  await nextMacrotask();
  const idle = gate.idle(IDLE_CAP_MS);
  await (signal ? untilAborted(idle, signal) : idle);
}
