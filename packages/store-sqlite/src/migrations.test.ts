import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appliedVersions, runMigrations, type Migration } from "./migrations.js";
import { MIGRATION_TABLE_NAME, SchemaTooNewError, assertSchemaVersion, hasColumn, hasTable, openDatabase } from "./open.js";

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

describe("forward-schema guard", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "titan-store-"));
    dbPath = path.join(dir, "store.db");
    const db = openDatabase(dbPath);
    runMigrations(db, [v1, v2]);
    db.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses to open a database stamped past the version the runtime knows", () => {
    expect(() => openDatabase(dbPath, { schemaVersion: 1 })).toThrow(SchemaTooNewError);
    expect(() => openDatabase(dbPath, { schemaVersion: 1 })).toThrow(/version 2, but this runtime knows only up to 1/);
  });

  it("names both versions on the error so a caller can report them", () => {
    let caught: SchemaTooNewError | null = null;
    try {
      openDatabase(dbPath, { schemaVersion: 1 });
    } catch (err) {
      caught = err as SchemaTooNewError;
    }

    expect(caught).toMatchObject({ name: "SchemaTooNewError", storedVersion: 2, knownVersion: 1 });
  });

  it("opens a database at or below the known version, and one with no migrations at all", () => {
    for (const schemaVersion of [2, 3]) {
      const db = openDatabase(dbPath, { schemaVersion });
      expect(appliedVersions(db)).toEqual([1, 2]);
      db.close();
    }
    const fresh = openDatabase(path.join(dir, "fresh.db"), { schemaVersion: 1 });
    expect(hasTable(fresh, MIGRATION_TABLE_NAME)).toBe(false);
    fresh.close();
  });

  it("checks a read-only connection, which cannot run migrations to find out", () => {
    expect(() => openDatabase(dbPath, { readonly: true, schemaVersion: 1 })).toThrow(SchemaTooNewError);
    const db = openDatabase(dbPath, { readonly: true });
    expect(() => assertSchemaVersion(db, 1)).toThrow(SchemaTooNewError);
    expect(() => assertSchemaVersion(db, 2)).not.toThrow();
    db.close();
  });
});
