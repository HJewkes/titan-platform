/** Runs `run` over `items` with at most `limit` in flight; resolves to how many rejected, and never rejects itself. */
export async function settleBounded<T>(items: readonly T[], limit: number, run: (item: T) => Promise<unknown>): Promise<number> {
  let next = 0;
  let failed = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!;
      await run(item).catch(() => void failed++);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return failed;
}
