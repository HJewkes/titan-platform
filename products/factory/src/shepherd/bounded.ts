/** How many PR reads a resync keeps in flight: enough to start serving in seconds, few enough to stay polite to GitHub. */
export const RESYNC_CONCURRENCY = 6;

/** How long one resync PR read may take before it counts as unreadable; a REST read over `gh api` has no deadline of its own. */
export const RESYNC_READ_TIMEOUT_MS = 20_000;

/** A read that missed its deadline. The read itself is abandoned, not stopped, and its late answer is dropped. */
export class ReadTimedOut extends Error {
  constructor(timeoutMs: number) {
    super(`the read timed out after ${timeoutMs} ms`);
    this.name = "ReadTimedOut";
  }
}

export interface BoundedOptions {
  /** Settles an item that takes longer than this as a `ReadTimedOut` rejection, so its worker moves on. */
  timeoutMs?: number;
}

/** Races `promise` against a timer that rejects with `ReadTimedOut`; the timer never keeps the process alive. */
async function withDeadline<R>(promise: Promise<R>, timeoutMs: number): Promise<R> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadTimedOut(timeoutMs)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Maps every item through `fn` with at most `limit` calls in flight. Results come back in input order and settled, so one
 * rejection never cancels the others, and with `timeoutMs` one call that never answers never holds the rest.
 */
export async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>, { timeoutMs }: BoundedOptions = {}): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  const call = (item: T): Promise<R> => (timeoutMs === undefined ? fn(item) : withDeadline(fn(item), timeoutMs));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await call(items[index]!) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

/** The value of a settled read, or its error thrown where the caller walks to it, as the sequential read would have thrown. */
export function settledValue<R>(result: PromiseSettledResult<R>): R {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

/** Like `settledValue`, but a read that timed out reads as no value, the same as a PR that could not be read. */
export function readValue<R>(result: PromiseSettledResult<R>): R | undefined {
  if (result.status === "rejected" && result.reason instanceof ReadTimedOut) return undefined;
  return settledValue(result);
}
