import type { ClosedStatus, OwnerItem, SourceEvent } from "@titan-design/owner-queue";

const POLL_TAIL_MS = 30_000;

interface PollTailOptions {
  open: () => Promise<OwnerItem[]>;
  /** How a ref that left the open set closed; sources that cannot tell say `gone-elsewhere`. */
  closedAs?: (ref: string) => ClosedStatus;
  intervalMs?: number;
}

const refOf = (item: OwnerItem): string => item.sources[0]!.ref;

/**
 * A tail for a source with no event stream: re-read `open()` each interval and emit the difference. Cursors are
 * counters local to one tail, so a caller's cursor from another process cannot be replayed and gets a `resync`.
 */
export function pollTail(options: PollTailOptions): (cursor: string | undefined, signal: AbortSignal) => AsyncIterable<SourceEvent> {
  const closedAs = options.closedAs ?? (() => "gone-elsewhere" as const);
  const intervalMs = options.intervalMs ?? POLL_TAIL_MS;
  return async function* tail(cursor, signal) {
    let seq = 0;
    const next = (): string => String(++seq);
    if (cursor !== undefined) yield { type: "resync", cursor: next() };
    let known = new Map((await options.open()).map((item) => [refOf(item), item]));
    while (await pause(intervalMs, signal)) {
      const current = new Map((await options.open()).map((item) => [refOf(item), item]));
      for (const [ref, item] of current) if (!known.has(ref)) yield { type: "opened", item, cursor: next() };
      for (const ref of known.keys()) if (!current.has(ref)) yield { type: "closed", ref, status: closedAs(ref), cursor: next() };
      known = current;
    }
  };
}

/** False once `signal` aborts, before or during the wait. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
