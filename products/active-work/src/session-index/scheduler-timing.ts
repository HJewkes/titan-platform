/** Whether an on-demand refresh finished inside the caller's budget. */
export type Freshness = 'fresh' | 'stale';

/** A timer that `cancel` ends early, so `close()` never waits out a backoff. */
export function cancellableSleep(ms: number): { done: Promise<void>; cancel: () => void } {
  let cancel = (): void => {};
  const done = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    cancel = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { done, cancel };
}

/** Resolves `'fresh'` if `pass` succeeds within `budgetMs`, else `'stale'` at the budget. */
export async function withinBudget(
  pass: (expired: () => boolean) => Promise<boolean>,
  budgetMs: number,
): Promise<Freshness> {
  let timer: NodeJS.Timeout | undefined;
  let over = false;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      over = true;
      resolve(false);
    }, budgetMs);
    timer.unref?.();
  });
  const ok = await Promise.race([pass(() => over), expired]);
  clearTimeout(timer);
  return ok ? 'fresh' : 'stale';
}
