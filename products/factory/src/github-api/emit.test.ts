import { githubApiPool, type PoolAnswer } from "@titan-design/github";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { eventLogMigration, readEvents } from "../event-log/event-log.js";
import { POOL_NOW, fakePoolClock, rateLimitAnswer } from "../test-support/pool-clock.js";
import { apiAvailableEmitter, apiAvailableKey, appendApiAvailable } from "./emit.js";
import { githubApiPoolMigration, sqlitePoolStateStore } from "./pool-state.js";

const BOT = "example-bot[bot]";
const RESET_AT = POOL_NOW + 60_000;
const OBSERVED = new Date(POOL_NOW + 61_000);

function logDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [eventLogMigration(), githubApiPoolMigration()]);
  return db;
}

describe("ApiAvailable", () => {
  it("appends a store row under the identity rule's key, in epoch seconds", () => {
    const db = logDb();

    appendApiAvailable(db, BOT, "graphql", RESET_AT, OBSERVED);

    expect(readEvents(db, { subject: BOT, sinceSeq: 0 })).toEqual([
      expect.objectContaining({
        source: "store",
        kind: "ApiAvailable",
        repo: null,
        occurrenceKey: `v1|ApiAvailable|${BOT}|graphql|${RESET_AT / 1000}`,
        keys: { identity: BOT, class: "graphql", resetAt: RESET_AT },
        observedAt: OBSERVED.toISOString(),
      }),
    ]);
  });

  it("inserts nothing for a second onAvailable of the same reopen", () => {
    const db = logDb();
    const onAvailable = apiAvailableEmitter(db, () => OBSERVED.getTime());

    onAvailable(BOT, "core-read", RESET_AT);
    onAvailable(BOT, "core-read", RESET_AT);

    expect(readEvents(db, { subject: BOT, sinceSeq: 0 })).toHaveLength(1);
  });

  it("keys a later reopen of the same class, and another class, as their own occurrences", () => {
    expect(new Set([apiAvailableKey(BOT, "core-read", RESET_AT), apiAvailableKey(BOT, "core-read", RESET_AT + 120_000), apiAvailableKey(BOT, "mutation", RESET_AT)]).size).toBe(3);
  });

  it("is what the pool's canary appends when it reopens a tripped pair", async () => {
    const db = logDb();
    const clock = fakePoolClock();
    let answer: PoolAnswer = { status: 429, headers: {} };
    const pool = githubApiPool<string, PoolAnswer>({
      identity: BOT,
      send: () => Promise.resolve(answer),
      clock,
      probe: () => Promise.resolve(rateLimitAnswer(4999, 4999)),
      state: sqlitePoolStateStore(db, clock.now),
      onAvailable: apiAvailableEmitter(db, clock.now),
    });
    await pool.run(3, "core-read", "trips");
    answer = { status: 200, headers: {} };

    const canary = pool.run(3, "core-read", "canary");
    await clock.advance(61_000);
    await canary;

    expect(readEvents(db, { subject: BOT, sinceSeq: 0 }).map((row) => row.occurrenceKey)).toEqual([apiAvailableKey(BOT, "core-read", RESET_AT)]);
  });
});
