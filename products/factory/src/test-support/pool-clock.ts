import type { PoolClock, RateLimitProbeAnswer } from "@titan-design/github";

export const POOL_NOW = Date.parse("2027-01-15T08:00:00.000Z");

export interface FakePoolClock extends PoolClock {
  advance(ms: number): Promise<void>;
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Timers fire in order at their own instant, each followed by the microtasks it starts, so a pool's probe and canary run in sequence. */
export function fakePoolClock(start = POOL_NOW): FakePoolClock {
  let now = start;
  const timers: { at: number; wake: () => void }[] = [];
  return {
    now: () => now,
    sleep: (ms) => new Promise<void>((wake) => void timers.push({ at: now + ms, wake })),
    async advance(ms) {
      const target = now + ms;
      await settle();
      for (let due = nextDue(timers, target); due; due = nextDue(timers, target)) {
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

function nextDue<T extends { at: number }>(timers: T[], target: number): T | undefined {
  return timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
}

/** A synthetic `GET /rate_limit` answer; `resetS` is epoch seconds. */
export function rateLimitAnswer(core: number, graphql: number, resetS = Math.floor(POOL_NOW / 1000) + 3600): RateLimitProbeAnswer {
  const bucket = (remaining: number) => ({ limit: 5000, used: 5000 - remaining, remaining, reset: resetS });
  return { status: 200, body: { resources: { core: bucket(core), graphql: bucket(graphql) } } };
}
