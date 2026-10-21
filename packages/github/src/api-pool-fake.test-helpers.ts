import type { PoolClock, RateLimitProbeAnswer } from "./api-pool.js";

export const NOW = 1_800_000_000_000;

interface FakeClock extends PoolClock {
  advance(ms: number): Promise<void>;
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Timers fire in order, each at its own instant, with the microtasks it starts drained before the next one. */
export function fakeClock(): FakeClock {
  let now = NOW;
  const timers: { at: number; wake: () => void }[] = [];
  return {
    now: () => now,
    sleep: (ms) => new Promise<void>((wake) => void timers.push({ at: now + ms, wake })),
    async advance(ms) {
      const target = now + ms;
      await settle();
      for (;;) {
        const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        now = due.at;
        due.wake();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

/** A synthetic `GET /rate_limit` body; `reset` is epoch seconds. */
export function rateLimitBody(core: number, graphql: number, resetS = Math.floor(NOW / 1000) + 3600): RateLimitProbeAnswer {
  const bucket = (remaining: number) => ({ limit: 5000, used: 5000 - remaining, remaining, reset: resetS });
  return { status: 200, body: { resources: { core: bucket(core), graphql: bucket(graphql) }, rate: bucket(core) } };
}

export const BOTH_OPEN = rateLimitBody(4999, 4999);
