/** Resolves with "SIGTERM", "SIGINT" or "abort", whichever comes first, and removes every listener it added. */
export function untilStopped(stop?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    const done = (reason: string): void => {
      process.off("SIGTERM", done);
      process.off("SIGINT", done);
      stop?.removeEventListener("abort", aborted);
      resolve(reason);
    };
    const aborted = (): void => done("abort");
    process.once("SIGTERM", done);
    process.once("SIGINT", done);
    if (stop?.aborted) return done("abort");
    stop?.addEventListener("abort", aborted, { once: true });
  });
}
