import type { Logger } from "@titan-design/daemon";

export interface Sweep {
  readonly name: string;
  tick(): Promise<void>;
  /** Clears the timer and refuses later ticks; a tick already running keeps running. */
  halt(): void;
  /** The tick running now, or null; it never rejects. */
  inFlight(): Promise<void> | null;
  /** `halt()`, then wait for the running tick without a bound. */
  stop(): Promise<void>;
}

/** One tick at a time, every `everyMs`; adoption picks up runs whose owning process exited without releasing. */
export function startSweep(tickOnce: () => Promise<void>, everyMs: number, name: string, log: Logger): Sweep {
  let inFlight: Promise<void> | null = null;
  let halted = false;
  const tick = (): Promise<void> => {
    if (halted) return inFlight ?? Promise.resolve();
    return (inFlight ??= tickOnce()
      .catch((err: unknown) => log.error({ err }, `${name} failed`))
      .finally(() => (inFlight = null)));
  };
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  const halt = (): void => {
    halted = true;
    clearInterval(timer);
  };
  return {
    name,
    tick,
    halt,
    inFlight: () => inFlight,
    stop: async () => {
      halt();
      await inFlight;
    },
  };
}
