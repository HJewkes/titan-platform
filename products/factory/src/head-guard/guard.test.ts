import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import type { Ancestry, Unavailable } from "./classify.js";
import { advanceEpoch, headEpochMigration, readEpoch } from "./epoch-store.js";
import { guardedHeadRead, RETRY_DELAYS_MS, type GuardDeps } from "./guard.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const KEY = { repo: "o/r", pr: 7 };
const AT = "2026-10-20T12:00:00.000Z";
const DOWN: Unavailable = { kind: "unavailable", resetAt: "2026-10-20T12:05:00Z" };

interface Script {
  reads: (string | Unavailable)[];
  ancestry?: Ancestry | Unavailable;
  lsRemote?: string | null | Unavailable;
}

interface Harness {
  db: Db;
  deps: GuardDeps;
  sleeps: number[];
  calls: { read: number; ls: number };
}

function harness(script: Script): Harness {
  const db = openDatabase(":memory:");
  runMigrations(db, [headEpochMigration()]);
  const sleeps: number[] = [];
  const calls = { read: 0, ls: 0 };
  const deps: GuardDeps = {
    db,
    readHead: async () => script.reads[Math.min(calls.read++, script.reads.length - 1)]!,
    ancestry: async () => script.ancestry ?? "diverged",
    lsRemote: async () => {
      calls.ls += 1;
      return script.lsRemote ?? null;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => new Date(AT),
  };
  return { db, deps, sleeps, calls };
}

const seed = (db: Db, ...heads: string[]): void => {
  heads.forEach((head, index) => advanceEpoch(db, { ...KEY, expectedEpoch: index, head, by: index === 0 ? "bootstrap" : "fast-forward", at: AT }));
};

describe.each(["webhook", "polling"])("sources=%s", () => {
  it("a stale head read moves no epoch", async () => {
    const { db, deps, sleeps } = harness({ reads: [SHA_A], ancestry: "behind", lsRemote: SHA_B });
    seed(db, SHA_A, SHA_B);

    const result = await guardedHeadRead(deps, KEY);

    expect(result).toEqual({ outcome: "unknown" });
    expect(readEpoch(db, KEY)).toMatchObject({ head: SHA_B, epoch: 2 });
    expect(sleeps).toHaveLength(5);
  });
});

describe("guardedHeadRead", () => {
  it("keeps the epoch across an unseen A to B to A", async () => {
    const { db, deps } = harness({ reads: [SHA_A], ancestry: "identical" });
    seed(db, SHA_A);

    const result = await guardedHeadRead(deps, KEY);

    expect(result).toEqual({ outcome: "same", head: SHA_A, epoch: 1 });
    expect(readEpoch(db, KEY)?.epoch).toBe(1);
  });

  it("moves the epoch once on a force-push back that ls-remote confirms", async () => {
    const { db, deps } = harness({ reads: [SHA_A], ancestry: "behind", lsRemote: SHA_A });
    seed(db, SHA_A, SHA_B);

    const first = await guardedHeadRead(deps, KEY);
    const again = await guardedHeadRead(deps, KEY);

    expect(first).toEqual({ outcome: "confirmed", head: SHA_A, epoch: 3 });
    expect(again).toEqual({ outcome: "same", head: SHA_A, epoch: 3 });
  });

  it("retries a stale read on the 8, 16, 24, 32, 40 second schedule, then answers unknown", async () => {
    const { deps, sleeps, calls } = harness({ reads: [SHA_A], ancestry: "behind", lsRemote: SHA_B });
    seed(deps.db, SHA_A, SHA_B);

    const result = await guardedHeadRead(deps, KEY);

    expect(result).toEqual({ outcome: "unknown" });
    expect(sleeps).toEqual([8_000, 16_000, 24_000, 32_000, 40_000]);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(120_000);
    expect(RETRY_DELAYS_MS).toEqual(sleeps);
    expect(calls.read).toBe(6);
  });

  it("stops retrying once the replica catches up", async () => {
    const { db, deps, sleeps } = harness({ reads: [SHA_A, SHA_A, SHA_B], ancestry: "behind", lsRemote: SHA_B });
    seed(db, SHA_A, SHA_B);
    deps.ancestry = async (_key, _base, head) => (head === SHA_A ? "behind" : "identical");

    const result = await guardedHeadRead(deps, KEY);

    expect(result).toEqual({ outcome: "same", head: SHA_B, epoch: 2 });
    expect(sleeps).toEqual([8_000, 16_000]);
  });

  it("returns Unavailable as is, counts no try and writes nothing", async () => {
    const { db, deps, sleeps } = harness({ reads: [DOWN] });

    const result = await guardedHeadRead(deps, KEY);

    expect(result).toBe(DOWN);
    expect(sleeps).toEqual([]);
    expect(readEpoch(db, KEY)).toBeUndefined();
  });

  it("returns an Unavailable ancestry read without writing", async () => {
    const { db, deps, sleeps } = harness({ reads: [SHA_B], ancestry: DOWN });
    seed(db, SHA_A);

    const result = await guardedHeadRead(deps, KEY);

    expect(result).toBe(DOWN);
    expect(sleeps).toEqual([]);
    expect(readEpoch(db, KEY)?.epoch).toBe(1);
  });

  it("bootstraps epoch 1 when ls-remote agrees with the first read", async () => {
    const { db, deps } = harness({ reads: [SHA_A], lsRemote: SHA_A });

    const result = await guardedHeadRead(deps, KEY);

    expect(result).toEqual({ outcome: "confirmed", head: SHA_A, epoch: 1 });
    expect(readEpoch(db, KEY)?.head).toBe(SHA_A);
  });

  it("re-classifies once against the row that won a lost compare-and-set", async () => {
    const { db, deps } = harness({ reads: [SHA_B], ancestry: "ahead" });
    seed(db, SHA_A);
    const ancestry = deps.ancestry;
    let raced = false;
    deps.ancestry = async (key, base, head) => {
      const answer = await ancestry(key, base, head);
      if (!raced) {
        raced = true;
        advanceEpoch(db, { ...KEY, expectedEpoch: 1, head: SHA_B, by: "fast-forward", at: AT });
      }
      return answer;
    };

    const result = await guardedHeadRead(deps, KEY);

    expect(result).toEqual({ outcome: "same", head: SHA_B, epoch: 2 });
    expect(raced).toBe(true);
  });

  it("treats a compare-and-set lost on both attempts as stale and goes on to the next try", async () => {
    const { db, deps, sleeps } = harness({ reads: [SHA_B], ancestry: "ahead" });
    seed(db, SHA_A);
    const heads = ["c".repeat(40), "d".repeat(40), "e".repeat(40), "f".repeat(40)];
    let raced = 0;
    deps.ancestry = async () => {
      const winner = heads[raced++];
      const current = readEpoch(db, KEY)!;
      if (winner !== undefined) advanceEpoch(db, { ...KEY, expectedEpoch: current.epoch, head: winner, by: "fast-forward", at: AT });
      return "ahead";
    };

    const result = await guardedHeadRead(deps, KEY);

    expect(result).toEqual({ outcome: "confirmed", head: SHA_B, epoch: 6 });
    expect(sleeps).toEqual([8_000, 16_000]);
  });
});
