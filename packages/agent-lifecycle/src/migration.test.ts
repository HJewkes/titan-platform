import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { executionLedgerMigration } from "./migration.js";
import { SqliteExecutionLedger } from "./sqlite-execution-ledger.js";

describe("execution ledger migration", () => {
  it("is additive and reusable under a custom table name", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec("CREATE TABLE retained_product_state(value TEXT); INSERT INTO retained_product_state VALUES ('keep')");
      runMigrations(db, [executionLedgerMigration(1, "product_execution")]);
      runMigrations(db, [executionLedgerMigration(1, "product_execution")]);
      const ledger = new SqliteExecutionLedger(db, { table: "product_execution" });
      expect(ledger.listRecoverable()).toEqual([]);
      expect(db.prepare("SELECT value FROM retained_product_state").get()).toEqual({ value: "keep" });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'session_%'").all()).toEqual([]);
    } finally { db.close(); }
  });
});
