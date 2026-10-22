import { githubApiPool, memoryPoolStateStore, type PoolAnswer } from "@titan-design/github";
import { describe, expect, it, vi } from "vitest";
import { POOL_NOW, fakePoolClock, rateLimitAnswer } from "../test-support/pool-clock.js";
import { githubApiStatus } from "./status.js";

const BOT = "example-bot[bot]";
const UNAUTHORIZED: PoolAnswer = { status: 401, headers: {}, message: "Bad credentials" };

describe("the github-auth ops alarm", () => {
  it("logs one alarm line for twenty 401 answers, and health reports every class in auth", async () => {
    const store = memoryPoolStateStore();
    const log = vi.fn();
    const status = githubApiStatus({ identity: BOT, store, log });
    const probe = vi.fn(() => Promise.resolve(rateLimitAnswer(4999, 4999)));
    const pool = githubApiPool<number, PoolAnswer>({ identity: BOT, send: () => Promise.resolve(UNAUTHORIZED), clock: fakePoolClock(), probe, state: store, onAuthFailed: (identity) => status.onAuthFailed(identity) });

    await Promise.all(Array.from({ length: 20 }, (_, item) => pool.run(1, "core-read", item)));

    expect(log.mock.calls).toEqual([[`factory: ops-alarm github-auth identity=${BOT}`]]);
    expect(probe).not.toHaveBeenCalled();
    expect(status.health()).toEqual({ "core-read": { state: "auth", resetAt: null }, graphql: { state: "auth", resetAt: null }, mutation: { state: "auth", resetAt: null } });
  });

  it("alarms again only after a token change ends the first transition", () => {
    const log = vi.fn();
    const status = githubApiStatus({ identity: BOT, store: memoryPoolStateStore(), log });

    status.onAuthFailed(BOT);
    status.onAuthFailed(BOT);
    status.tokenChanged();
    status.onAuthFailed(BOT);

    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe("githubApiStatus health", () => {
  it("reports each class's stored state, with resetAt only while it is not open", () => {
    const store = memoryPoolStateStore();
    store.set(BOT, "graphql", { state: "closed", resetAt: POOL_NOW, streak: 1, bucket: "graphql" });
    store.set(BOT, "mutation", { state: "open", resetAt: 0, streak: 0 });

    const health = githubApiStatus({ identity: BOT, store, log: vi.fn() }).health();

    expect(health).toEqual({ "core-read": { state: "open", resetAt: null }, graphql: { state: "closed", resetAt: new Date(POOL_NOW).toISOString() }, mutation: { state: "open", resetAt: null } });
  });
});
