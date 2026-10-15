import { TtsTimeoutError } from "./errors.js";

/**
 * Runs `work` with a signal that aborts at the deadline or when `outer` aborts. A deadline rejects with
 * TtsTimeoutError even if `work` ignores its signal, so a hung engine cannot hold the caller.
 */
export async function withDeadline<T>(
  providerId: string,
  timeoutMs: number,
  outer: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort(outer?.reason);
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  if (outer?.aborted) onOuterAbort();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new TtsTimeoutError(providerId, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}
