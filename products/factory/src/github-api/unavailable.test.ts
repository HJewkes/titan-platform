import { githubApiPool, type PoolAnswer } from "@titan-design/github";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { factoryMigrations } from "../host.js";
import { POOL_NOW, fakePoolClock, rateLimitAnswer } from "../test-support/pool-clock.js";
import type { CiFact } from "../test-support/a17/ci-shapes.js";
import type { Feed } from "../test-support/a17/feed.js";
import { a17Event } from "../test-support/a17/register.js";
import { sqlitePoolStateStore } from "./pool-state.js";

const BOT = "example-bot[bot]";
/** The header-less secondary-limit 403 of the A17 incident (slice a's C4). */
const SECONDARY_LIMIT: PoolAnswer = { status: 403, headers: {}, message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." };

function factoryDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, factoryMigrations());
  return db;
}

/** Row count of every table in the factory database, so any write outside the pool's own row shows up. */
function rowCounts(db: Db): Record<string, number> {
  const tables = db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM "${name}"`).get()?.n ?? 0]));
}

describe("the pool contract under an Unavailable read", () => {
  it("returns Unavailable as a value and changes only its own pool-state row", async () => {
    const db = factoryDb();
    const clock = fakePoolClock();
    const pool = githubApiPool<string, PoolAnswer>({ identity: BOT, send: () => Promise.resolve(SECONDARY_LIMIT), clock, probe: () => Promise.resolve(rateLimitAnswer(4999, 4999)), state: sqlitePoolStateStore(db, clock.now) });
    const before = rowCounts(db);

    const result = await pool.run(3, "core-read", "GET /repos/example-org/example-repo/pulls/7");
    await clock.advance(0);

    expect(result).toEqual({ unavailable: { resetAt: POOL_NOW + 60_000, reason: "core limited (backoff)", class: "core-read" } });
    expect(before).toMatchObject({ factory_event: 0, workflow_run: 0, factory_github_api_pool: 0 });
    expect(rowCounts(db)).toEqual({ ...before, factory_github_api_pool: 1 });
  });

  it("holds a repeat read while closed without sending it, leaving the row's streak where the trip set it", async () => {
    const db = factoryDb();
    const clock = fakePoolClock();
    const send = vi.fn(() => Promise.resolve(SECONDARY_LIMIT));
    const pool = githubApiPool<string, PoolAnswer>({ identity: BOT, send, clock, probe: () => Promise.resolve(rateLimitAnswer(4999, 4999)), state: sqlitePoolStateStore(db, clock.now) });
    await pool.run(1, "core-read", "first");
    const afterTrip = rowCounts(db);

    const repeats = [pool.run(1, "core-read", "second"), pool.run(1, "core-read", "third")];
    await clock.advance(30_000);
    const pending = await Promise.race([Promise.all(repeats).then(() => "settled"), Promise.resolve("held")]);

    expect(pending).toBe("held");
    expect(send).toHaveBeenCalledTimes(1);
    expect(rowCounts(db)).toEqual(afterTrip);
    expect(db.prepare("SELECT state, streak FROM factory_github_api_pool").get()).toEqual({ state: "closed", streak: 1 });
  });
});

const HEAD = "a".repeat(40);
const check = (over: Partial<CiFact> = {}): CiFact => ({ type: "check", repo: "o/r", head: HEAD, context: "build", checkRunId: 101, outcome: "success", at: "2026-10-17T10:00:00Z", ...over });

interface PoolRow {
  call_class: string;
  state: string;
  reset_at: number;
  streak: number;
  reason: string | null;
  updated_at: string;
}

const poolRows = (feed: Feed): PoolRow[] => feed.db.prepare<[], PoolRow>("SELECT call_class, state, reset_at, streak, reason, updated_at FROM factory_github_api_pool ORDER BY call_class").all();
const backstopRows = (feed: Feed): number => feed.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM factory_event WHERE source = 'backstop'").get()?.n ?? 0;

/** Every table but the pool's own row and the event log, whose webhook rows the ingress writes without the pool. */
function markers(db: Db): Record<string, unknown[]> {
  const tables = Object.keys(rowCounts(db)).filter((name) => name !== "factory_github_api_pool" && name !== "factory_event");
  return Object.fromEntries(tables.map((name) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
}

describe("D-M1a-03 through the bot's pool on the reconciler (TP-3096)", () => {
  a17Event("a header-less secondary-limit 403 is Unavailable with a 60 s wait", async (feed) => {
    feed.limit(SECONDARY_LIMIT);

    const steps = await feed.fact(check());
    const [tripped] = poolRows(feed);
    await feed.advance();

    expect(steps).toEqual(feed.pick<string[]>({ webhook: ["inserted"], polling: [] }));
    expect(tripped).toMatchObject({ call_class: "graphql", state: "closed", streak: 1, reason: "graphql limited (backoff)" });
    expect(tripped!.reset_at - Date.parse(tripped!.updated_at)).toBe(60_000);
    expect(poolRows(feed)).toMatchObject([{ call_class: "graphql", state: "open", streak: 0 }]);
    expect(feed.read(`o/r@${HEAD}`, 0).map((row) => row.kind)).toContain("CIConcluded");
  });

  a17Event("an Unavailable read writes no marker and counts no re-drive", async (feed) => {
    await feed.fact(check());
    const before = { markers: markers(feed.db), backstop: backstopRows(feed), reads: feed.reads() };
    feed.limit(SECONDARY_LIMIT);

    await feed.fact(check({ checkRunId: 102, context: "lint" }));
    await feed.advance(30_000);

    expect(markers(feed.db)).toEqual(before.markers);
    expect(backstopRows(feed)).toBe(before.backstop);
    expect(feed.reads() - before.reads).toBe(1);
    expect(poolRows(feed)).toMatchObject([{ call_class: "graphql", state: "closed", streak: 1 }]);
  });
});
