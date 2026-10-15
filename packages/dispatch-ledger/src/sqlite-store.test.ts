import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { LedgerMalformedError, exportLedgerJson, parseLedgerJson } from "./json.js";
import type { Claim } from "./schema.js";
import { SqliteLedgerStore, dispatchLedgerDdl, dispatchLedgerMigration } from "./sqlite-store.js";
import { importLedgerJson } from "./store.js";
import { FIXTURE, describeLedgerStore } from "./store.test-helpers.js";

function memoryDb(): Db {
  const db = openDatabase(":memory:");
  db.exec(dispatchLedgerDdl());
  return db;
}

describeLedgerStore("sqlite", () => new SqliteLedgerStore(memoryDb()));

const claimRows = (db: Db) =>
  db.prepare("SELECT ordinal, task_id, slice, phase, seat, agent_name FROM dispatch_claim ORDER BY ordinal").all();

describe("SqliteLedgerStore", () => {
  it("round-trips the fixture byte-equal through a store reopened on the same database", () => {
    const db = memoryDb();
    importLedgerJson(new SqliteLedgerStore(db), FIXTURE);

    expect(exportLedgerJson(new SqliteLedgerStore(db).read().ledger)).toBe(FIXTURE);
  });

  it("keeps one row per claim in ledger order with its index columns", () => {
    const db = memoryDb();
    const store = new SqliteLedgerStore(db);

    importLedgerJson(store, FIXTURE);

    const claims = store.read().ledger.claims;
    expect(claimRows(db)).toEqual(
      claims.map((c: Claim, i) => ({
        ordinal: i,
        task_id: c.taskId,
        slice: c.slice ?? null,
        phase: c.phase,
        seat: c.seat ?? null,
        agent_name: c.agentName ?? null,
      })),
    );
  });

  it("stores the meta row with lastTickAt and the ledger minus its claims", () => {
    const db = memoryDb();

    importLedgerJson(new SqliteLedgerStore(db), FIXTURE);

    const meta: unknown = db.prepare("SELECT revision, last_tick_at, doc FROM dispatch_ledger_meta").get();
    expect(meta).toEqual({ revision: 1, last_tick_at: "2026-01-04T10:00:00.000Z", doc: expect.any(String) });
    const doc: unknown = db.prepare("SELECT doc FROM dispatch_ledger_meta").pluck().get();
    expect(JSON.parse(String(doc))).toHaveProperty("claims", []);
  });

  it("mounts through a store-sqlite migration", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [dispatchLedgerMigration(1)]);

    expect(new SqliteLedgerStore(db).read().revision).toBe(0);
  });
});

const tables = (db: Db) => ({
  claims: db.prepare("SELECT * FROM dispatch_claim ORDER BY ordinal").all(),
  meta: db.prepare("SELECT * FROM dispatch_ledger_meta").all(),
});

function importedDb(): Db {
  const db = memoryDb();
  importLedgerJson(new SqliteLedgerStore(db), FIXTURE);
  return db;
}

const CORRUPTIONS: Record<string, (db: Db) => void> = {
  "a meta doc that is not JSON": (db) => db.exec("UPDATE dispatch_ledger_meta SET doc = '{'"),
  "a claim row that is not JSON": (db) => db.exec("UPDATE dispatch_claim SET claim = 'secret-text{' WHERE ordinal = 1"),
  "a meta row with a non-integer revision": (db) => db.exec("UPDATE dispatch_ledger_meta SET revision = 1.5"),
  "claim rows with no meta row": (db) => db.exec("DELETE FROM dispatch_ledger_meta"),
};

describe("SqliteLedgerStore over a malformed store", () => {
  it.each(Object.entries(CORRUPTIONS))("reads %s as LedgerMalformedError, not an empty ledger", (_, corrupt) => {
    const db = importedDb();
    corrupt(db);

    expect(() => new SqliteLedgerStore(db).read()).toThrow(LedgerMalformedError);
  });

  it("names a corrupt claim row by ordinal and never echoes its text", () => {
    const db = importedDb();
    db.exec("UPDATE dispatch_claim SET claim = 'secret-text{' WHERE ordinal = 1");

    expect(() => new SqliteLedgerStore(db).read()).toThrow("stored dispatch claim 1 is not JSON");
    expect(() => new SqliteLedgerStore(db).read()).not.toThrow(/secret-text/);
  });

  it.each(Object.entries(CORRUPTIONS))("refuses a write over %s and leaves both tables unchanged", (_, corrupt) => {
    const db = importedDb();
    corrupt(db);
    const before = tables(db);

    expect(() => new SqliteLedgerStore(db).write(parseLedgerJson(FIXTURE))).toThrow(LedgerMalformedError);
    expect(tables(db)).toEqual(before);
  });
});
