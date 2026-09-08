import { describe, expect, it } from "vitest";
import { appliedVersions, runMigrations, type Migration } from "./migrations.js";
import { hasColumn, hasTable, openDatabase } from "./open.js";

const v1: Migration = { version: 1, name: "create t", up: (db) => db.exec("CREATE TABLE t (a INTEGER)") };
const v2: Migration = { version: 2, up: (db) => db.exec("ALTER TABLE t ADD COLUMN b TEXT") };

describe("runMigrations", () => {
  it("applies pending migrations in version order and records them", () => {
    const db = openDatabase(":memory:");
    expect(runMigrations(db, [v2, v1])).toEqual([1, 2]);
    expect(appliedVersions(db)).toEqual([1, 2]);
    expect(hasTable(db, "t")).toBe(true);
    expect(hasColumn(db, "t", "b")).toBe(true);
  });

  it("is a no-op on a second run and applies only what is new", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [v1]);
    expect(runMigrations(db, [v1])).toEqual([]);
    expect(runMigrations(db, [v1, v2])).toEqual([2]);
  });

  it("rolls back a failing migration and leaves earlier ones applied", () => {
    const db = openDatabase(":memory:");
    const bad: Migration = {
      version: 2,
      up: (d) => {
        d.exec("CREATE TABLE half (x)");
        throw new Error("boom");
      },
    };
    expect(() => runMigrations(db, [v1, bad])).toThrow("boom");
    expect(appliedVersions(db)).toEqual([1]);
    expect(hasTable(db, "half")).toBe(false);
  });

  it("rejects duplicate or non-positive versions before touching the database", () => {
    const db = openDatabase(":memory:");
    expect(() => runMigrations(db, [v1, { ...v2, version: 1 }])).toThrow(/duplicate migration version/);
    expect(() => runMigrations(db, [{ ...v1, version: 0 }])).toThrow(/positive integer/);
    expect(hasTable(db, "t")).toBe(false);
  });
});
