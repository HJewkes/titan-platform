import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appliedVersions, openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { advanceEpoch, headEpochMigration, readEpoch, type EpochAdvance } from "./epoch-store.js";
import { guardedHeadRead, type GuardDeps } from "./guard.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const KEY = { repo: "o/r", pr: 7 };
const AT = "2026-10-20T12:00:00.000Z";

const step = (overrides: Partial<EpochAdvance> = {}): EpochAdvance => ({ ...KEY, expectedEpoch: 0, head: SHA_A, by: "bootstrap", at: AT, ...overrides });

function memory(): Db {
  const opened = openDatabase(":memory:");
  runMigrations(opened, [headEpochMigration()]);
  return opened;
}

describe("head epoch migration", () => {
  it("registers as version 34", () => {
    const opened = memory();

    expect(appliedVersions(opened)).toContain(34);
  });
});

describe("advanceEpoch", () => {
  it("opens epoch 1, then moves one step per matching expectation", () => {
    const opened = memory();

    const first = advanceEpoch(opened, step());
    const second = advanceEpoch(opened, step({ expectedEpoch: 1, head: SHA_B, by: "fast-forward" }));

    expect([first, second]).toEqual([{ advanced: true, epoch: 1 }, { advanced: true, epoch: 2 }]);
    expect(readEpoch(opened, KEY)).toEqual({ head: SHA_B, epoch: 2, earlierConfirmed: [SHA_A] });
  });

  it("refuses a step whose expected epoch is no longer current", () => {
    const opened = memory();
    advanceEpoch(opened, step());

    const lost = advanceEpoch(opened, step({ head: SHA_B }));

    expect(lost).toEqual({ advanced: false, current: 1 });
    expect(readEpoch(opened, KEY)?.head).toBe(SHA_A);
  });

  it("keys on the lowercased repo", () => {
    const opened = memory();
    advanceEpoch(opened, step({ repo: "O/R" }));

    expect(readEpoch(opened, KEY)?.epoch).toBe(1);
  });
});

describe("two writers on one file", () => {
  it("lets exactly one of two racing steps win, leaving epoch 2 and two change rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "head-epoch-"));
    const path = join(dir, "factory.db");
    const first = openDatabase(path);
    runMigrations(first, [headEpochMigration()]);
    const second = openDatabase(path);
    advanceEpoch(first, step());

    const results = [advanceEpoch(first, step({ expectedEpoch: 1, head: SHA_B, by: "fast-forward" })), advanceEpoch(second, step({ expectedEpoch: 1, head: "c".repeat(40), by: "non-ancestor" }))];

    expect(results.filter((result) => result.advanced)).toHaveLength(1);
    expect(readEpoch(second, KEY)?.epoch).toBe(2);
    expect(first.prepare("SELECT COUNT(*) AS n FROM factory_head_epoch_change").get()).toEqual({ n: 2 });
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("change history", () => {
  it("aborts an UPDATE and a DELETE", () => {
    const opened = memory();
    advanceEpoch(opened, step());

    expect(() => opened.exec("UPDATE factory_head_epoch_change SET head_sha = 'x'")).toThrow(/append-only/);
    expect(() => opened.exec("DELETE FROM factory_head_epoch_change")).toThrow(/append-only/);
  });
});

describe("the epoch transaction", () => {
  it("runs no port call while the write lock is held", async () => {
    const opened = memory();
    let sawOpenTransaction = false;
    const watch = <T>(value: T): T => {
      sawOpenTransaction ||= opened.inTransaction;
      return value;
    };
    const deps: GuardDeps = {
      db: opened,
      readHead: async () => watch(SHA_A),
      ancestry: async () => watch("identical" as const),
      lsRemote: async () => watch(SHA_A),
      sleep: async () => undefined,
      now: () => new Date(AT),
    };

    const result = await guardedHeadRead(deps, KEY);

    expect(result).toEqual({ outcome: "confirmed", head: SHA_A, epoch: 1 });
    expect(sawOpenTransaction).toBe(false);
  });
});
