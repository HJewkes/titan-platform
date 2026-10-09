import { openDatabase, type Db } from "@titan-design/store-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HealthSampleInput } from "./sample.js";
import * as store from "./store.js";
import { appendSamples, openHealthStore, readSamples, storeStats } from "./store.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (minute: number) => new Date(T0 + minute * 60_000);

function sample(minute: number, overrides: Partial<HealthSampleInput> = {}): HealthSampleInput {
  return { ts: at(minute).toISOString(), target: "factory", kind: "http", status: "pass", latencyMs: 4, ...overrides };
}

function rowCount(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM health_sample").get() as { n: number }).n;
}

let db: Db;
beforeEach(() => {
  db = openHealthStore(":memory:");
});
afterEach(() => db.close());

describe("appendSamples", () => {
  it("keeps every appended row, in order, across ticks", () => {
    appendSamples(db, [sample(0), sample(0, { target: "relay" })]);
    appendSamples(db, [sample(1, { status: "fail", output: "timeout after 5000 ms" })]);
    appendSamples(db, [sample(2, { observed: { code: 200, "build.sha": "abc" } })]);

    const rows = readSamples(db, "factory", at(0), at(3));

    expect(rows.map((row) => row.status)).toEqual(["pass", "fail", "pass"]);
    expect(rows[1]?.output).toBe("timeout after 5000 ms");
    expect(rows[2]?.observed).toEqual({ code: 200, "build.sha": "abc" });
    expect(rowCount(db)).toBe(4);
  });

  it("stores two identical consecutive probe results as two rows", () => {
    appendSamples(db, [sample(0)]);
    appendSamples(db, [sample(0)]);

    expect(rowCount(db)).toBe(2);
  });

  it("stores the same import row once when it carries a dedup key", () => {
    const imported = sample(0, { source: "import:shepherd-health", dedupKey: "k1" });

    const first = appendSamples(db, [imported]);
    const second = appendSamples(db, [imported]);

    expect([first, second]).toEqual([1, 0]);
    expect(rowCount(db)).toBe(1);
  });

  it("stores nothing from a batch with one invalid row", () => {
    const batch = [sample(0), sample(1), sample(2, { status: "up" as never }), sample(3), sample(4)];

    expect(() => appendSamples(db, batch)).toThrow();
    expect(rowCount(db)).toBe(0);
  });

  it("writes a whole batch in one transaction", () => {
    let commits = 0;
    const counted = new Proxy(db, {
      get(target, key) {
        if (key !== "transaction") return Reflect.get(target, key, target) as unknown;
        return (fn: (...args: never[]) => unknown) => {
          const tx = target.transaction(fn);
          return (...args: never[]) => {
            commits += 1;
            return tx(...args);
          };
        };
      },
    }) as Db;

    appendSamples(counted, [sample(0), sample(0, { target: "relay" }), sample(0, { target: "self", kind: "self" })]);

    expect(commits).toBe(1);
    expect(rowCount(db)).toBe(3);
  });
});

describe("readSamples", () => {
  it("returns only the target's rows inside [from, to)", () => {
    appendSamples(db, [sample(0), sample(1), sample(2), sample(1, { target: "relay" })]);

    const rows = readSamples(db, "factory", at(1), at(2));

    expect(rows.map((row) => row.ts)).toEqual([at(1).toISOString()]);
  });

  it("orders by instant even when stored ts strings carry offsets", () => {
    appendSamples(db, [sample(5), { ...sample(0), ts: "2026-01-01T01:01:00+01:00" }]);

    const rows = readSamples(db, "factory", at(0), at(10));

    expect(rows.map((row) => Date.parse(row.ts))).toEqual([at(1).getTime(), at(5).getTime()]);
  });
});

describe("append-only guarantee", () => {
  it("exports no function that deletes, updates or prunes samples", () => {
    const mutators = Object.keys(store).filter((name) =>
      /delete|update|prune|remove|purge|truncate|clear|drop|vacuum|compact|replace|edit/i.test(name),
    );

    expect(mutators).toEqual([]);
  });

  it("refuses a raw UPDATE or DELETE on a stored sample", () => {
    appendSamples(db, [sample(0)]);

    expect(() => db.exec("UPDATE health_sample SET status = 'pass'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM health_sample")).toThrow(/append-only/);
    expect(rowCount(db)).toBe(1);
  });
});

describe("storeStats", () => {
  it("reports an empty store with no oldest or newest ts", () => {
    expect(storeStats(db)).toMatchObject({ rows: 0, oldestTs: null, newestTs: null });
  });

  it("reports the row count, size and the oldest and newest ts", () => {
    appendSamples(db, [sample(3), sample(1), sample(2, { target: "relay" })]);

    const stats = storeStats(db);

    expect(stats).toMatchObject({ rows: 3, oldestTs: at(1).toISOString(), newestTs: at(3).toISOString() });
    expect(stats.bytes).toBeGreaterThan(0);
  });
});

describe("openHealthStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "health-store-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps rows across reopen and reads them through a read-only handle", () => {
    const file = path.join(dir, "nested", "health.sqlite3");
    const writer = openHealthStore(file);
    appendSamples(writer, [sample(0)]);
    writer.close();
    const reopened = openHealthStore(file);
    appendSamples(reopened, [sample(1)]);
    reopened.close();

    const reader = openHealthStore(file, { readonly: true });

    expect(readSamples(reader, "factory", at(0), at(2))).toHaveLength(2);
    reader.close();
  });

  it("refuses a file stamped by a newer schema", () => {
    const file = path.join(dir, "health.sqlite3");
    openHealthStore(file).close();
    const raw = openDatabase(file);
    raw.prepare("INSERT INTO _migration (version, name, applied_at) VALUES (99, 'future', 'x')").run();
    raw.close();

    expect(() => openHealthStore(file)).toThrow(/schema is at version 99/);
  });
});
