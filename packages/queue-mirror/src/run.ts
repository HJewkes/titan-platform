import { createMirror, SILENT, type Mirror, type MirrorBus, type MirrorOptions } from "./mirror.js";
import { syncFilter } from "./render.js";
import { DEFAULT_BACKOFF, abortableSleep, superviseLoop } from "./supervise.js";
import type { MirrorState, QueueSource } from "./types.js";

type Body = (reset: () => void) => Promise<void>;

function streamEnded(name: string, signal: AbortSignal): void {
  if (!signal.aborted) throw new Error(`${name} stream ended`);
}

// Opens the tail before reconciling, so an item opened during reconcile arrives through the tail.
function sourceLoop(mirror: Mirror, source: QueueSource, state: MirrorState, signal: AbortSignal): Body {
  return async (reset) => {
    const events = source.tail(state.sourceCursor(), signal);
    await mirror.reconcile();
    for await (const event of events) {
      await mirror.applySourceEvent(event);
      reset();
    }
    streamEnded("source", signal);
  };
}

function syncLoop(mirror: Mirror, bus: MirrorBus, state: MirrorState, options: MirrorOptions): Body {
  const { roomId, signal, syncTimeoutMs = 30_000 } = options;
  return async (reset) => {
    for await (const batch of bus.syncLoop({ since: state.syncToken(), filter: syncFilter(roomId), timeoutMs: syncTimeoutMs, signal })) {
      await mirror.applySyncBatch(batch);
      reset();
    }
    streamEnded("sync", signal);
  };
}

function sweepLoop(mirror: Mirror, options: MirrorOptions, sleep: NonNullable<MirrorOptions["sleep"]>): Body {
  const { signal, sweepIntervalMs = 5_000 } = options;
  return async (reset) => {
    while (!signal.aborted) {
      await mirror.sweepExpired();
      reset();
      await sleep(sweepIntervalMs, signal);
    }
  };
}

/** Runs the source tail (reconciling on each start), the sync loop and the expiry sweep until `signal` aborts. */
export async function runMirror(source: QueueSource, bus: MirrorBus, state: MirrorState, options: MirrorOptions): Promise<void> {
  const mirror = createMirror(source, bus, state, options);
  const sleep = options.sleep ?? abortableSleep;
  const supervise = { signal: options.signal, backoff: options.backoff ?? DEFAULT_BACKOFF, sleep, logger: options.logger ?? SILENT };
  await Promise.all([
    superviseLoop("source", sourceLoop(mirror, source, state, options.signal), supervise),
    superviseLoop("sync", syncLoop(mirror, bus, state, options), supervise),
    superviseLoop("sweep", sweepLoop(mirror, options, sleep), supervise),
  ]);
}
