import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { exportLedgerJson } from "./json.js";
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

    const meta = db.prepare("SELECT revision, last_tick_at, doc FROM dispatch_ledger_meta").get() as {
      revision: number;
      last_tick_at: string;
      doc: string;
    };
    expect(meta.revision).toBe(1);
    expect(meta.last_tick_at).toBe("2026-01-04T10:00:00.000Z");
    expect(JSON.parse(meta.doc).claims).toEqual([]);
  });

  it("mounts through a store-sqlite migration", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [dispatchLedgerMigration(1)]);

    expect(new SqliteLedgerStore(db).read().revision).toBe(0);
  });
});
