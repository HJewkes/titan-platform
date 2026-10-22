import { describe, expect, it } from "vitest";
import {
  githubApiPool,
  isPoolUnavailable,
  memoryPoolStateStore,
  type PoolAnswer,
  type PoolPriority,
  type RateLimitProbeAnswer,
} from "./api-pool.js";
import { BOTH_OPEN, NOW, fakeClock, rateLimitBody } from "./api-pool-fake.test-helpers.js";
import type { CallClass } from "./github-failure.js";

const OK: PoolAnswer = { status: 200, headers: {} };
const LIMITED: PoolAnswer = { status: 429, headers: {} };
const UNAUTHORIZED: PoolAnswer = { status: 401, headers: {}, message: "Bad credentials" };

interface Call {
  id: string;
  answer?: PoolAnswer;
  gate?: Promise<PoolAnswer>;
}

/** Each probe answer is taken in turn; the last one repeats. */
function harness(probeAnswers: (RateLimitProbeAnswer | Error)[] = [BOTH_OPEN]) {
  const clock = fakeClock();
  const state = memoryPoolStateStore();
  const sent: { id: string; at: number }[] = [];
  const probes: number[] = [];
  const available: [string, CallClass, number][] = [];
  const authFailed: string[] = [];
  const send = async (call: Call) => {
    sent.push({ id: call.id, at: clock.now() - NOW });
    return call.gate ? call.gate : (call.answer ?? OK);
  };
  const probe = async () => {
    const answer = probeAnswers[Math.min(probes.length, probeAnswers.length - 1)]!;
    probes.push(clock.now() - NOW);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const pool = githubApiPool({
    identity: "bot",
    send,
    clock,
    state,
    probe,
    onAvailable: (identity, callClass, resetAt) => void available.push([identity, callClass, resetAt - NOW]),
    onAuthFailed: (identity) => void authFailed.push(identity),
  });
  const run = (priority: PoolPriority, callClass: CallClass, call: Call) => pool.run(priority, callClass, call);
  const ids = () => sent.map((record) => record.id);
  return { clock, state, pool, run, sent, ids, probes, available, authFailed };
}

function gated() {
  let finish: (answer: PoolAnswer) => void = () => undefined;
  const gate = new Promise<PoolAnswer>((resolve) => (finish = resolve));
  return { gate, finish };
}

describe("githubApiPool reopen probe", () => {
  it("probes GET /rate_limit once at resetAt, not before", async () => {
    const h = harness();
    await h.run(3, "core-read", { id: "trip", answer: LIMITED });
    await h.clock.advance(59_999);
    expect(h.probes).toEqual([]);

    await h.clock.advance(1);
    await h.clock.advance(60_000);
    expect(h.probes).toEqual([60_000]);
  });

  it("reopens core-read when core is open, and keeps graphql closed while its bucket is at 0", async () => {
    const graphqlResetS = Math.floor(NOW / 1000) + 600;
    const h = harness([rateLimitBody(4999, 0, graphqlResetS)]);
    await h.run(3, "core-read", { id: "trip-core", answer: LIMITED });
    await h.run(1, "graphql", { id: "trip-graphql", answer: LIMITED });
    const read = h.run(1, "core-read", { id: "read" });
    void h.run(1, "graphql", { id: "query" });
    await h.clock.advance(60_000);
    await read;

    expect(h.ids()).toEqual(["trip-core", "trip-graphql", "read"]);
    expect(h.state.get("bot", "graphql")).toMatchObject({ state: "closed", resetAt: graphqlResetS * 1000, streak: 1 });
    expect(h.available).toEqual([["bot", "core-read", 60_000]]);
  });

  it("probes the core bucket for a mutation trip", async () => {
    const h = harness([rateLimitBody(10, 0)]);
    const secondary: PoolAnswer = { status: 403, headers: { "x-ratelimit-resource": "graphql" }, message: "You have exceeded a secondary rate limit" };
    await h.run(1, "mutation", { id: "trip", answer: secondary });
    const write = h.run(1, "mutation", { id: "write" });
    await h.clock.advance(60_000);

    await expect(write).resolves.toEqual(OK);
    expect(h.available).toEqual([["bot", "mutation", 60_000]]);
  });

  it("re-arms a failed or 5xx probe at 60 s without doubling the streak", async () => {
    const h = harness([{ status: 502 }, new Error("socket hang up"), { networkError: true }, BOTH_OPEN]);
    await h.run(3, "core-read", { id: "trip", answer: LIMITED });
    await h.clock.advance(240_000);
    expect(h.probes).toEqual([60_000, 120_000, 180_000, 240_000]);

    const canary = await h.run(3, "core-read", { id: "canary", answer: LIMITED });
    expect(isPoolUnavailable(canary) && canary.unavailable.resetAt - NOW).toBe(240_000 + 120_000);
  });

  it("keeps the pair closed to the bucket's own reset when the probe says it is still at 0", async () => {
    const resetS = Math.floor(NOW / 1000) + 300;
    const h = harness([rateLimitBody(0, 4999, resetS), BOTH_OPEN]);
    await h.run(3, "core-read", { id: "trip", answer: LIMITED });
    const read = h.run(3, "core-read", { id: "read" });
    await h.clock.advance(299_999);
    expect(h.ids()).toEqual(["trip"]);

    await h.clock.advance(1);
    await read;
    expect(h.probes).toEqual([60_000, 300_000]);
    expect(h.ids()).toEqual(["trip", "read"]);
  });
});

describe("githubApiPool reopen probe, stale reset", () => {
  it("re-arms at 60 s when the bucket is at 0 but its reset is already past", async () => {
    const h = harness([rateLimitBody(0, 4999, Math.floor(NOW / 1000)), BOTH_OPEN]);
    await h.run(3, "core-read", { id: "trip", answer: LIMITED });
    await h.clock.advance(180_000);

    expect(h.probes).toEqual([60_000, 120_000]);
  });
});

describe("githubApiPool reopen canary", () => {
  it("sends one canary of five queued calls, the highest-priority one, until it returns ok", async () => {
    const h = harness();
    const canary = gated();
    await h.run(1, "core-read", { id: "trip", answer: LIMITED });
    const runs = [
      h.run(4, "core-read", { id: "backstop" }),
      h.run(3, "core-read", { id: "item-a" }),
      h.run(2, "core-read", { id: "pacer", gate: canary.gate }),
      h.run(3, "core-read", { id: "item-b" }),
      h.run(4, "core-read", { id: "backstop-b" }),
    ];
    await h.clock.advance(120_000);
    expect(h.ids()).toEqual(["trip", "pacer"]);

    canary.finish(OK);
    await Promise.all(runs);
    expect(h.ids()).toEqual(["trip", "pacer", "item-a", "item-b", "backstop", "backstop-b"]);
    expect(h.available).toEqual([["bot", "core-read", 60_000]]);
  });

  it("closes the pair again with the streak doubled when the canary is unavailable", async () => {
    const h = harness();
    await h.run(3, "core-read", { id: "trip", answer: LIMITED });
    const canary = h.run(3, "core-read", { id: "canary", answer: LIMITED });
    const next = h.run(3, "core-read", { id: "next" });
    await h.clock.advance(60_000);

    const result = await canary;
    expect(isPoolUnavailable(result) && result.unavailable.resetAt - NOW).toBe(60_000 + 120_000);
    expect(h.state.get("bot", "core-read")).toMatchObject({ state: "closed", streak: 2 });
    await h.clock.advance(120_000);
    await next;
    expect(h.sent.map((record) => record.at)).toEqual([0, 60_000, 180_000]);
    expect(h.available).toEqual([["bot", "core-read", 180_000]]);
  });

  it("leaves the pair probed with nothing queued, and makes the next call the canary", async () => {
    const h = harness();
    await h.run(3, "graphql", { id: "trip", answer: LIMITED });
    await h.clock.advance(60_000);
    expect(h.state.get("bot", "graphql")).toMatchObject({ state: "probed" });
    expect(h.available).toEqual([]);

    await h.run(4, "graphql", { id: "later" });
    expect(h.state.get("bot", "graphql")).toEqual({ state: "open", resetAt: 0, streak: 0 });
    expect(h.available).toEqual([["bot", "graphql", 60_000]]);
  });

  it("keeps the pair probed when the canary errors, and sends the next queued call as the canary", async () => {
    const h = harness();
    await h.run(3, "core-read", { id: "trip", answer: LIMITED });
    const first = h.run(3, "core-read", { id: "missing", answer: { status: 404, headers: {} } });
    const second = h.run(3, "core-read", { id: "found" });
    await h.clock.advance(60_000);
    await Promise.all([first, second]);

    expect(h.ids()).toEqual(["trip", "missing", "found"]);
    expect(h.available).toEqual([["bot", "core-read", 60_000]]);
  });

  it("does not let a call that was in flight before the trip reopen the pair", async () => {
    const h = harness();
    const slow = gated();
    const inFlight = h.run(3, "core-read", { id: "slow", gate: slow.gate });
    await h.run(3, "core-read", { id: "trip", answer: LIMITED });
    slow.finish(OK);
    await inFlight;

    expect(h.state.get("bot", "core-read")).toMatchObject({ state: "closed", streak: 1 });
    expect(h.available).toEqual([]);
  });
});

describe("githubApiPool auth state", () => {
  it("raises one onAuthFailed for 20 calls answered 401, and never probes", async () => {
    const h = harness();
    await h.run(3, "graphql", { id: "trip", answer: LIMITED });
    const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => h.run(1, "core-read", { id: `read-${i}`, answer: UNAUTHORIZED })));
    await h.clock.advance(600_000);

    expect(answers.every((answer) => answer === UNAUTHORIZED)).toBe(true);
    expect(h.authFailed).toEqual(["bot"]);
    expect(h.probes).toEqual([]);
  });

  it("holds every class while in auth, priority 1 included, until the token changes", async () => {
    const h = harness();
    await h.run(1, "core-read", { id: "rejected", answer: UNAUTHORIZED });
    const held = [h.run(1, "mutation", { id: "write" }), h.run(1, "graphql", { id: "query" }), h.run(4, "core-read", { id: "read" })];
    await h.clock.advance(3_600_000);
    expect(h.ids()).toEqual(["rejected"]);

    h.pool.tokenChanged();
    await Promise.all(held);
    expect(h.ids()).toEqual(["rejected", "write", "query", "read"]);
  });

  it("fires onAuthFailed again only after a token change clears the state", async () => {
    const h = harness();
    await h.run(1, "core-read", { id: "a", answer: UNAUTHORIZED });
    h.pool.tokenChanged();
    await h.run(1, "core-read", { id: "b", answer: UNAUTHORIZED });

    expect(h.authFailed).toEqual(["bot", "bot"]);
  });

  it("enters auth when the probe itself answers 401", async () => {
    const h = harness([{ status: 401 }, BOTH_OPEN]);
    await h.run(3, "core-read", { id: "trip", answer: LIMITED });
    const read = h.run(3, "core-read", { id: "read" });
    await h.clock.advance(600_000);
    expect(h.authFailed).toEqual(["bot"]);
    expect(h.probes).toEqual([60_000]);

    h.pool.tokenChanged();
    await read;
    expect(h.ids()).toEqual(["trip", "read"]);
  });
});
