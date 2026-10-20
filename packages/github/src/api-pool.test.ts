import { describe, expect, it } from "vitest";
import {
  githubApiPool,
  isPoolUnavailable,
  memoryPoolStateStore,
  type PoolAnswer,
  type PoolClock,
  type PoolPriority,
  type PoolStateStore,
} from "./api-pool.js";
import type { CallClass } from "./github-failure.js";

const NOW = 1_800_000_000_000;
const OK: PoolAnswer = { status: 200, headers: {} };
const LIMITED: PoolAnswer = { status: 429, headers: {} };

interface FakeClock extends PoolClock {
  advance(ms: number): Promise<void>;
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function fakeClock(): FakeClock {
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

interface Call {
  id: string;
  answer?: PoolAnswer;
  takesMs?: number;
  gate?: Promise<PoolAnswer>;
  fails?: Error;
}

interface Sent {
  id: string;
  at: number;
  endedAt?: number;
}

function harness(state?: PoolStateStore) {
  const clock = fakeClock();
  const sent: Sent[] = [];
  const send = async (call: Call): Promise<PoolAnswer> => {
    const record: Sent = { id: call.id, at: clock.now() };
    sent.push(record);
    if (call.takesMs) await clock.sleep(call.takesMs);
    if (call.fails) throw call.fails;
    const answer = call.gate ? await call.gate : (call.answer ?? OK);
    record.endedAt = clock.now();
    return answer;
  };
  const pool = githubApiPool({ identity: "bot", send, clock, state });
  const run = (priority: PoolPriority, callClass: CallClass, call: Call) => pool.run(priority, callClass, call);
  const ids = () => sent.map((record) => record.id);
  return { clock, pool, run, sent, ids };
}

async function tripAndWait(h: ReturnType<typeof harness>, callClass: CallClass): Promise<number> {
  const result = await h.run(1, callClass, { id: `trip-${callClass}`, answer: LIMITED });
  if (!isPoolUnavailable(result)) throw new Error("expected the call to trip its pair");
  const waitMs = result.unavailable.resetAt - h.clock.now();
  await h.clock.advance(waitMs);
  return waitMs;
}

describe("githubApiPool grant order", () => {
  it("grants in priority order, then first come first served within a priority", async () => {
    const h = harness();
    const runs = [
      h.run(4, "core-read", { id: "backstop" }),
      h.run(3, "core-read", { id: "item-a" }),
      h.run(1, "core-read", { id: "lander-a" }),
      h.run(2, "graphql", { id: "pacer" }),
      h.run(3, "core-read", { id: "item-b" }),
      h.run(1, "core-read", { id: "lander-b" }),
    ];
    await Promise.all(runs);

    expect(h.ids()).toEqual(["lander-a", "lander-b", "pacer", "item-a", "item-b", "backstop"]);
  });
});

describe("githubApiPool mutation lane", () => {
  it("never overlaps two mutations and starts each at least 1000 ms after the last one started", async () => {
    const h = harness();
    const runs = [
      h.run(2, "mutation", { id: "m1", takesMs: 1500 }),
      h.run(2, "mutation", { id: "m2", takesMs: 10 }),
      h.run(2, "mutation", { id: "m3", takesMs: 10 }),
    ];
    await h.clock.advance(5000);
    await Promise.all(runs);

    expect(h.sent.map((record) => record.at - NOW)).toEqual([0, 1500, 2500]);
    for (const [previous, next] of [[0, 1], [1, 2]] as const) {
      expect(h.sent[next]!.at).toBeGreaterThanOrEqual(h.sent[previous]!.endedAt!);
    }
  });

  it("serves queued mutations in priority order", async () => {
    const h = harness();
    const runs = [h.run(4, "mutation", { id: "low" }), h.run(1, "mutation", { id: "high" }), h.run(2, "mutation", { id: "mid" })];
    await h.clock.advance(3000);
    await Promise.all(runs);

    expect(h.ids()).toEqual(["high", "mid", "low"]);
  });

  it("does not hold reads behind a mutation in flight", async () => {
    const h = harness();
    void h.run(1, "mutation", { id: "slow-write", takesMs: 5000 });
    await h.clock.advance(1);
    await h.run(4, "core-read", { id: "read" });

    expect(h.ids()).toEqual(["slow-write", "read"]);
  });
});

describe("githubApiPool token release", () => {
  it("releases the mutation token when the call returns, not before", async () => {
    let finish: (answer: PoolAnswer) => void = () => undefined;
    const h = harness();
    const first = h.run(1, "mutation", { id: "first", gate: new Promise((resolve) => (finish = resolve)) });
    const second = h.run(1, "mutation", { id: "second" });
    await h.clock.advance(10_000);
    expect(h.ids()).toEqual(["first"]);

    finish(OK);
    await Promise.all([first, second]);
    expect(h.ids()).toEqual(["first", "second"]);
    expect(h.sent[1]!.at - NOW).toBe(10_000);
  });

  it("releases the token when the send throws, and rejects only that call", async () => {
    const h = harness();
    const failing = h.run(1, "mutation", { id: "boom", fails: new Error("socket closed") });
    const next = h.run(1, "mutation", { id: "next" });
    await expect(failing).rejects.toThrow("socket closed");
    await h.clock.advance(1000);

    await expect(next).resolves.toEqual(OK);
  });
});

describe("githubApiPool unavailable", () => {
  it("returns Unavailable as a value with the reset, the reason and the class", async () => {
    const h = harness();
    const result = await h.run(3, "core-read", { id: "limited", answer: { status: 403, headers: { "retry-after": "30" } } });

    expect(result).toEqual({ unavailable: { resetAt: NOW + 30_000, reason: "core limited (retry-after)", class: "core-read" } });
  });

  it("grants nothing on a tripped (identity, class) until its resetAt, priority 1 included", async () => {
    const h = harness();
    await h.run(1, "core-read", { id: "trip", answer: LIMITED });
    const waiting = h.run(1, "core-read", { id: "after" });
    await h.clock.advance(59_999);
    expect(h.ids()).toEqual(["trip"]);

    await h.clock.advance(1);
    await waiting;
    expect(h.ids()).toEqual(["trip", "after"]);
    expect(h.sent[1]!.at - NOW).toBe(60_000);
  });

  it("grants the identity's other classes only at priority 1 until the trip's resetAt", async () => {
    const h = harness();
    await h.run(1, "graphql", { id: "trip", answer: LIMITED });
    const runs = [
      h.run(2, "core-read", { id: "pacer-read" }),
      h.run(4, "mutation", { id: "backstop-write" }),
      h.run(1, "mutation", { id: "lander-write" }),
      h.run(1, "core-read", { id: "lander-read" }),
    ];
    await h.clock.advance(59_999);
    expect(h.ids()).toEqual(["trip", "lander-write", "lander-read"]);

    await h.clock.advance(1);
    await Promise.all(runs);
    expect(h.ids()).toEqual(["trip", "lander-write", "lander-read", "pacer-read", "backstop-write"]);
  });

  it("doubles the streak of one (identity, class) and leaves every other pair at 60 s", async () => {
    const h = harness();
    const graphqlWaits = [await tripAndWait(h, "graphql"), await tripAndWait(h, "graphql"), await tripAndWait(h, "graphql")];

    expect(graphqlWaits).toEqual([60_000, 120_000, 240_000]);
    expect(await tripAndWait(h, "core-read")).toBe(60_000);
    expect(await tripAndWait(h, "mutation")).toBe(60_000);
  });

  it("resets only the streak of the pair that succeeded", async () => {
    const h = harness();
    await tripAndWait(h, "graphql");
    await tripAndWait(h, "graphql");
    await tripAndWait(h, "core-read");

    await h.run(1, "core-read", { id: "recovered" });

    expect(await tripAndWait(h, "core-read")).toBe(60_000);
    expect(await tripAndWait(h, "graphql")).toBe(240_000);
  });

  it("counts calls that were already in flight when their pair tripped as one trip", async () => {
    const h = harness();
    const both = [h.run(3, "core-read", { id: "a", answer: LIMITED }), h.run(3, "core-read", { id: "b", answer: LIMITED })];
    const results = await Promise.all(both);

    expect(results.map((result) => isPoolUnavailable(result) && result.unavailable.resetAt - NOW)).toEqual([60_000, 60_000]);
    await h.clock.advance(60_000);
    expect(await tripAndWait(h, "core-read")).toBe(120_000);
  });

  it("passes unknown and error answers through without closing or counting", async () => {
    const store = memoryPoolStateStore();
    const h = harness(store);
    const unknown: PoolAnswer = { status: 502, headers: {} };
    const invalid: PoolAnswer = { status: 422, headers: {}, message: "Validation Failed" };

    expect(await h.run(1, "mutation", { id: "write", answer: unknown })).toBe(unknown);
    expect(await h.run(3, "core-read", { id: "read", answer: invalid })).toBe(invalid);
    expect(store.get("bot", "mutation")).toBeUndefined();
    expect(store.get("bot", "core-read")).toBeUndefined();
  });
});

describe("githubApiPool state store", () => {
  it("keeps state in memory by default, one store per pool", async () => {
    const tripped = harness();
    const fresh = harness();
    await tripped.run(1, "core-read", { id: "trip", answer: LIMITED });

    await fresh.run(4, "core-read", { id: "fresh-read" });
    const blocked = tripped.run(4, "core-read", { id: "blocked-read" });
    await tripped.clock.advance(1);

    expect(fresh.ids()).toEqual(["fresh-read"]);
    expect(tripped.ids()).toEqual(["trip"]);
    await tripped.clock.advance(60_000);
    await blocked;
  });

  it("writes the trip to the store it is given, keyed by identity and class", async () => {
    const store = memoryPoolStateStore();
    const h = harness(store);
    await h.run(1, "graphql", { id: "trip", answer: { status: 403, headers: {}, message: "You have exceeded a secondary rate limit" } });

    expect(store.get("bot", "graphql")).toEqual({ state: "closed", resetAt: NOW + 60_000, streak: 1, bucket: "graphql", reason: "graphql limited (backoff)" });
    expect(store.get("other-bot", "graphql")).toBeUndefined();
  });

  it("honours a pair that the given store already holds closed", async () => {
    const store = memoryPoolStateStore();
    store.set("bot", "core-read", { state: "closed", resetAt: NOW + 5000, streak: 1 });
    const h = harness(store);
    const read = h.run(1, "core-read", { id: "read" });
    await h.clock.advance(4999);
    expect(h.ids()).toEqual([]);

    await h.clock.advance(1);
    await read;
    expect(h.ids()).toEqual(["read"]);
  });
});
