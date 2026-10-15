import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LedgerMalformedError } from "./json.js";
import {
  SqliteOwedHoldStore,
  dispatchOwedHoldsDdl,
  dispatchOwedHoldsMigration,
  exportOwedHoldsJson,
  memoryOwedHoldStore,
  parseOwedHoldsJson,
  type OwedHold,
  type OwedHoldStore,
} from "./owed-holds.js";
import { dispatchLedgerMigration } from "./sqlite-store.js";

const FIXTURE = fs.readFileSync(new URL("./fixtures/owed-holds.json", import.meta.url), "utf8");

const owed: OwedHold = { seat: "seat-a", repo: "Acme/Widgets", pr: 7, reason: 'burndown: sensitive word "gate" in T-1' };

function memoryDb(): Db {
  const db = openDatabase(":memory:");
  db.exec(dispatchOwedHoldsDdl());
  return db;
}

function describeOwedHoldStore(name: string, make: () => OwedHoldStore): void {
  describe(`${name} OwedHoldStore contract`, () => {
    it("owes nothing before the first write", () => {
      expect(make().read()).toEqual([]);
    });

    it("reads back what was written, in write order", () => {
      const store = make();
      const holds = parseOwedHoldsJson(FIXTURE);

      store.write(holds);

      expect(store.read()).toEqual(holds);
    });

    it("write replaces the set; a second hold on the same repo and PR keeps one entry in the first one's place", () => {
      const store = make();
      store.write([owed, { ...owed, pr: 8 }]);

      store.write([{ ...owed, pr: 9 }, owed, { ...owed, pr: 9, reason: "later" }]);

      expect(store.read()).toEqual([{ ...owed, pr: 9, reason: "later" }, owed]);
    });

    it("refuses a hold the schema refuses and keeps the stored set", () => {
      const store = make();
      store.write([owed]);

      expect(() => store.write([{ ...owed, pr: 1.5 }])).toThrow(LedgerMalformedError);
      expect(store.read()).toEqual([owed]);
    });

    it("hands out copies, so editing a read set changes nothing stored", () => {
      const store = make();
      store.write([owed]);

      store.read().push({ ...owed, pr: 8 });

      expect(store.read()).toEqual([owed]);
    });
  });
}

describeOwedHoldStore("memory", () => memoryOwedHoldStore());
describeOwedHoldStore("sqlite", () => new SqliteOwedHoldStore(memoryDb()));

describe("owed holds JSON (CC-931)", () => {
  it("reads a missing file, non-JSON and a non-array as no holds", () => {
    expect(parseOwedHoldsJson(undefined)).toEqual([]);
    expect(parseOwedHoldsJson("{")).toEqual([]);
    expect(parseOwedHoldsJson("{}")).toEqual([]);
  });

  it("import drops a malformed entry and keeps the rest", () => {
    const text = JSON.stringify([owed, { seat: "seat-a", pr: "seven" }, { ...owed, pr: 8 }]);

    expect(parseOwedHoldsJson(text)).toEqual([owed, { ...owed, pr: 8 }]);
  });

  it("exports the fixture back to its own bytes", () => {
    expect(exportOwedHoldsJson(parseOwedHoldsJson(FIXTURE))).toBe(FIXTURE);
  });
});

describe("SqliteOwedHoldStore", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips the owed-holds fixture byte-equal through a sqlite store reopened on the same database", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-owed-holds-"));
    const file = path.join(dir, "factory.db");
    const first = openDatabase(file);
    first.exec(dispatchOwedHoldsDdl());
    new SqliteOwedHoldStore(first).write(parseOwedHoldsJson(FIXTURE));
    first.close();

    const reopened = openDatabase(file);

    expect(exportOwedHoldsJson(new SqliteOwedHoldStore(reopened).read())).toBe(FIXTURE);
    reopened.close();
  });

  it("reads a stored row the schema refuses as LedgerMalformedError naming no stored text", () => {
    const db = memoryDb();
    new SqliteOwedHoldStore(db).write([owed]);
    db.prepare("UPDATE dispatch_owed_hold SET pr = 'seven-secret'").run();

    expect(() => new SqliteOwedHoldStore(db).read()).toThrow(LedgerMalformedError);
    expect(() => new SqliteOwedHoldStore(db).read()).not.toThrow(/seven-secret/);
  });

  it("the migration creates dispatch_owed_hold beside the ledger tables", () => {
    const db = openDatabase(":memory:");

    runMigrations(db, [dispatchLedgerMigration(1), dispatchOwedHoldsMigration(2)]);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'dispatch_%' ORDER BY name")
      .all();
    expect(tables).toEqual([{ name: "dispatch_claim" }, { name: "dispatch_ledger_meta" }, { name: "dispatch_owed_hold" }]);
  });
});
