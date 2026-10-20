import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubApiPool, type PoolAnswer, type RateLimitProbeAnswer } from "@titan-design/github";
import { appliedVersions, openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { factoryMigrations } from "../host.js";
import { POOL_NOW, fakePoolClock, rateLimitAnswer, type FakePoolClock } from "../test-support/pool-clock.js";
import { githubApiPoolMigration, sqlitePoolStateStore } from "./pool-state.js";

const BOT = "example-bot[bot]";
const OK: PoolAnswer = { status: 200, headers: {} };
const LIMITED: PoolAnswer = { status: 429, headers: {} };
const RESET_AT = POOL_NOW + 60_000;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "github-api-pool-"));
  dirs.push(dir);
  return join(dir, "factory.sqlite3");
}

function open(path: string): Db {
  const db = openDatabase(path);
  runMigrations(db, [githubApiPoolMigration()]);
  return db;
}

function poolOver(db: Db, clock: FakePoolClock, send: (call: string) => Promise<PoolAnswer>, probe: () => Promise<RateLimitProbeAnswer>, onAvailable = vi.fn()) {
  return githubApiPool<string, PoolAnswer>({ identity: BOT, send, clock, probe, onAvailable, state: sqlitePoolStateStore(db, clock.now) });
}

/** Trips core-read on a first database, then closes it, as a serve restart would. */
async function tripThenClose(path: string): Promise<void> {
  const db = open(path);
  const clock = fakePoolClock();
  const pool = poolOver(db, clock, () => Promise.resolve(LIMITED), () => Promise.resolve(rateLimitAnswer(4999, 4999)));
  await pool.run(3, "core-read", "first");
  await closeAfterPump(db, clock);
}

/** A settled call queues one more pump, which must not reach a closed database. */
async function closeAfterPump(db: Db, clock: FakePoolClock): Promise<void> {
  await clock.advance(0);
  db.close();
}

function rowOf(db: Db): unknown {
  return db.prepare("SELECT state, reset_at AS resetAt, streak FROM factory_github_api_pool WHERE identity = ? AND call_class = 'core-read'").get(BOT);
}

describe("github-api pool migration", () => {
  it("registers as version 35 among the factory migrations", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, factoryMigrations());

    expect(appliedVersions(db)).toContain(35);
  });

  it("keeps auth state out of the table", () => {
    const db = open(":memory:");

    const insertAuth = () => db.prepare("INSERT INTO factory_github_api_pool VALUES (?, 'graphql', 'auth', 0, 0, NULL, NULL, '')").run(BOT);

    expect(insertAuth).toThrow(/CHECK constraint/);
  });
});

describe("sqlitePoolStateStore", () => {
  it("round-trips a closed pair with its bucket and reason, and a probed pair without them", () => {
    const store = sqlitePoolStateStore(open(":memory:"), () => POOL_NOW);
    store.set(BOT, "graphql", { state: "closed", resetAt: RESET_AT, streak: 2, bucket: "graphql", reason: "graphql limited (x-ratelimit-reset)" });
    store.set(BOT, "mutation", { state: "probed", resetAt: RESET_AT, streak: 1 });

    expect(store.get(BOT, "graphql")).toEqual({ state: "closed", resetAt: RESET_AT, streak: 2, bucket: "graphql", reason: "graphql limited (x-ratelimit-reset)" });
    expect(store.get(BOT, "mutation")).toEqual({ state: "probed", resetAt: RESET_AT, streak: 1 });
    expect(store.get(BOT, "core-read")).toBeUndefined();
  });

  it("keeps one row per pair, overwritten in place with the time of the write", () => {
    const db = open(":memory:");
    let now = POOL_NOW;
    const store = sqlitePoolStateStore(db, () => now);
    store.set(BOT, "core-read", { state: "closed", resetAt: RESET_AT, streak: 1, bucket: "core", reason: "limited" });
    now += 5_000;
    store.set(BOT, "core-read", { state: "open", resetAt: 0, streak: 0 });

    expect(db.prepare("SELECT state, bucket, reason, updated_at AS updatedAt FROM factory_github_api_pool").all()).toEqual([
      { state: "open", bucket: null, reason: null, updatedAt: new Date(POOL_NOW + 5_000).toISOString() },
    ]);
  });
});

describe("a closed pair across a restart", () => {
  it("stays closed on a reopened database: nothing is sent and no probe runs before its resetAt", async () => {
    const path = dbFile();
    await tripThenClose(path);
    const db = open(path);
    const clock = fakePoolClock();
    const send = vi.fn(() => Promise.resolve(OK));
    const probe = vi.fn(() => Promise.resolve(rateLimitAnswer(4999, 4999)));
    const pool = poolOver(db, clock, send, probe);

    void pool.run(3, "core-read", "after restart");
    await clock.advance(59_000);

    expect(rowOf(db)).toEqual({ state: "closed", resetAt: RESET_AT, streak: 1 });
    expect([send.mock.calls.length, probe.mock.calls.length]).toEqual([0, 0]);
    await closeAfterPump(db, clock);
  });

  it("stays closed past its resetAt while the probe finds the bucket empty", async () => {
    const path = dbFile();
    await tripThenClose(path);
    const db = open(path);
    const clock = fakePoolClock();
    const send = vi.fn(() => Promise.resolve(OK));
    const pool = poolOver(db, clock, send, () => Promise.resolve(rateLimitAnswer(0, 4999)));

    void pool.run(3, "core-read", "after restart");
    await clock.advance(61_000);

    expect(rowOf(db)).toEqual({ state: "closed", resetAt: POOL_NOW + 3_600_000, streak: 1 });
    expect(send).not.toHaveBeenCalled();
    await closeAfterPump(db, clock);
  });

  it("reopens only through the probe and then one canary, firing onAvailable once with the trip's resetAt", async () => {
    const path = dbFile();
    await tripThenClose(path);
    const db = open(path);
    const clock = fakePoolClock();
    let finishCanary = (_answer: PoolAnswer) => undefined as void;
    const send = vi.fn((call: string) => (call === "canary" ? new Promise<PoolAnswer>((resolve) => (finishCanary = resolve)) : Promise.resolve(OK)));
    const probe = vi.fn(() => Promise.resolve(rateLimitAnswer(4999, 4999)));
    const onAvailable = vi.fn();
    const pool = poolOver(db, clock, send, probe, onAvailable);

    const runs = [pool.run(3, "core-read", "canary"), pool.run(3, "core-read", "next")];
    await clock.advance(61_000);
    const whileCanary = { row: rowOf(db), sent: send.mock.calls.map(([call]) => call) };
    finishCanary(OK);
    await Promise.all(runs);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(whileCanary).toEqual({ row: { state: "probed", resetAt: RESET_AT, streak: 1 }, sent: ["canary"] });
    expect(send.mock.calls.map(([call]) => call)).toEqual(["canary", "next"]);
    expect(rowOf(db)).toEqual({ state: "open", resetAt: 0, streak: 0 });
    expect(onAvailable.mock.calls).toEqual([[BOT, "core-read", RESET_AT]]);
    await closeAfterPump(db, clock);
  });
});
