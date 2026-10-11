/** How many PR reads a resync keeps in flight: enough to start serving in seconds, few enough to stay polite to GitHub. */
export const RESYNC_CONCURRENCY = 6;

/**
 * Maps every item through `fn` with at most `limit` calls in flight. Results come back in input order and settled, so one
 * rejection never cancels the others.
 */
export async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index]!) };
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
