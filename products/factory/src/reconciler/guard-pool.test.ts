import { githubApiPool, isPoolUnavailable, memoryPoolStateStore, type GithubApiPool, type PoolAnswer } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { advanceEpoch, headEpochMigration, readEpoch } from "../head-guard/epoch-store.js";
import { guardedHeadRead, type Ancestry, type GuardDeps, type Unavailable } from "../head-guard/guard.js";
import { fakePoolClock, POOL_NOW, rateLimitAnswer } from "../test-support/pool-clock.js";

const KEY = { repo: "example-org/widgets", pr: 7 };
const STORED = "a1".padEnd(40, "0");
const READ = "a2".padEnd(40, "0");
const AT = "2027-01-15T07:00:00.000Z";
const RETRY_AFTER_S = 61;

type ReadKind = "head" | "ancestry" | "ls-remote";
type Call = { kind: ReadKind };
type Answer = PoolAnswer & { sha?: string; ancestry?: Ancestry };

const RATE_LIMITED: Answer = { status: 429, headers: { "retry-after": String(RETRY_AFTER_S) } };
const UNAUTHORIZED: Answer = { status: 401, headers: {}, message: "Bad credentials" };

/** The real pool over a stubbed transport; `answers` says what each read kind gets, and `sent` records what went out. */
function rig(answers: Partial<Record<ReadKind, Answer>>) {
  const clock = fakePoolClock();
  const db = openDatabase(":memory:");
  runMigrations(db, [headEpochMigration()]);
  advanceEpoch(db, { ...KEY, expectedEpoch: 0, head: STORED, by: "bootstrap", at: AT });
  const sent: ReadKind[] = [];
  const authFailed: string[] = [];
  const send = async (call: Call): Promise<Answer> => (sent.push(call.kind), answers[call.kind] ?? { status: 200, headers: {}, sha: READ, ancestry: "behind" });
  const pool = githubApiPool<Call, Answer>({ identity: "synthetic-bot", send, clock, state: memoryPoolStateStore(), probe: () => Promise.resolve(rateLimitAnswer(4999, 4999)), onAuthFailed: (identity) => void authFailed.push(identity) });
  const sleeps: number[] = [];
  const deps: GuardDeps = {
    db,
    readHead: () => read(pool, "head", (answer) => answer.sha ?? ""),
    ancestry: () => read(pool, "ancestry", (answer) => answer.ancestry ?? "missing"),
    lsRemote: () => read(pool, "ls-remote", (answer) => answer.sha ?? null),
    sleep: async (ms) => void sleeps.push(ms),
    now: () => new Date(AT),
  };
  return { clock, db, deps, sent, sleeps, authFailed, pool };
}

/** As the reconciler's claim does: a refused call is `Unavailable` with its reset, and any other answer without a value throws. */
async function read<T>(pool: GithubApiPool<Call, Answer>, kind: ReadKind, pick: (answer: Answer) => T): Promise<T | Unavailable> {
  const answer = await pool.run(3, "core-read", { kind });
  if (isPoolUnavailable(answer)) return { kind: "unavailable", resetAt: new Date(answer.unavailable.resetAt).toISOString() };
  if (answer.status !== 200) throw new Error(`${kind} answered status ${answer.status ?? "none"}`);
  return pick(answer);
}

describe("head guard over the github-api pool (TP-3424)", () => {
  it.each(["head", "ancestry", "ls-remote"] as const)("returns the pool's Unavailable as is for a rate-limited %s read, with no try counted and no epoch moved", async (limited) => {
    const r = rig({ [limited]: RATE_LIMITED });

    const result = await guardedHeadRead(r.deps, KEY);

    expect(result).toEqual({ kind: "unavailable", resetAt: new Date(POOL_NOW + RETRY_AFTER_S * 1000).toISOString() });
    expect(r.sleeps).toEqual([]);
    expect(r.sent.filter((kind) => kind === limited)).toHaveLength(1);
    expect(readEpoch(r.db, KEY)).toMatchObject({ head: STORED, epoch: 1 });
  });

  it("raises the global auth alarm once on a 401, moves no epoch and retries no PR", async () => {
    const r = rig({ head: UNAUTHORIZED });

    await expect(guardedHeadRead(r.deps, KEY)).rejects.toThrow("status 401");
    const otherPr = guardedHeadRead(r.deps, { ...KEY, pr: 8 });
    await r.clock.advance(3_600_000);

    expect(r.authFailed).toEqual(["synthetic-bot"]);
    expect(r.sent).toEqual(["head"]);
    expect(r.sleeps).toEqual([]);
    expect(readEpoch(r.db, KEY)).toMatchObject({ head: STORED, epoch: 1 });
    r.pool.tokenChanged();
    await expect(otherPr).rejects.toThrow("status 401");
  });
});
