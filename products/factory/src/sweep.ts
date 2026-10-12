import type { Logger } from "@titan-design/daemon";

export interface Sweep {
  tick(): Promise<void>;
  stop(): Promise<void>;
}

/** One tick at a time, every `everyMs`; adoption picks up runs whose owning process exited without releasing. */
export function startSweep(tickOnce: () => Promise<void>, everyMs: number, name: string, log: Logger): Sweep {
  let inFlight: Promise<void> | null = null;
  const tick = (): Promise<void> =>
    (inFlight ??= tickOnce()
      .catch((err: unknown) => log.error({ err }, `${name} failed`))
      .finally(() => (inFlight = null)));
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  return {
    tick,
    stop: async () => {
      clearInterval(timer);
      await inFlight;
    },
  };
}
