import { afterEach, describe, expect, it, vi } from "vitest";
import { MigrationDriftError, appliedVersions, runMigrations, sqlMigration, type Migration } from "./migrations.js";
import { MIGRATION_TABLE_NAME, openDatabase, type Db } from "./open.js";

const CREATE_T = "CREATE TABLE t (a INTEGER)";
const v1: Migration = { version: 1, name: "create t", definition: CREATE_T, up: (db) => db.exec(CREATE_T) };
const edited: Migration = { ...v1, definition: "CREATE TABLE t (a INTEGER, b TEXT)" };

function recordedHash(db: Db, version: number): string | null {
  const row = db.prepare<[number], { hash: string | null }>(`SELECT hash FROM ${MIGRATION_TABLE_NAME} WHERE version = ?`).get(version);
  return row?.hash ?? null;
}

function legacyDatabase(): Db {
  const db = openDatabase(":memory:");
  db.exec(`CREATE TABLE ${MIGRATION_TABLE_NAME} (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT NOT NULL)`);
  db.exec(CREATE_T);
  db.prepare(`INSERT INTO ${MIGRATION_TABLE_NAME} (version, name, applied_at) VALUES (1, 'create t', '2026-01-01T00:00:00.000Z')`).run();
  return db;
}

describe("migration drift", () => {
  afterEach(() => vi.restoreAllMocks());

  it("throws MigrationDriftError when an applied migration's definition was edited", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [v1]);

    expect(() => runMigrations(db, [edited])).toThrow(MigrationDriftError);
    expect(() => runMigrations(db, [edited])).toThrow(/version 1 .*definition has changed/);
  });

  it("names the version and both hashes on the error", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [v1]);
    const before = recordedHash(db, 1);

    let caught: unknown = null;
    try {
      runMigrations(db, [edited]);
    } catch (err) {
      caught = err;
    }

    expect(before).toMatch(/^[0-9a-f]{64}$/);
    expect(caught).toBeInstanceOf(MigrationDriftError);
    expect(caught).toMatchObject({ name: "MigrationDriftError", version: 1, recordedHash: before });
    expect(caught).not.toMatchObject({ declaredHash: before });
    expect(caught).toHaveProperty("declaredHash", expect.stringMatching(/^[0-9a-f]{64}$/));
  });

  it("warns instead of throwing when the caller asks for warnings, and keeps going", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [v1]);
    const before = recordedHash(db, 1);
    const emit = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const v2: Migration = { version: 2, up: (d) => d.exec("CREATE TABLE u (x)") };

    expect(runMigrations(db, [edited, v2], { onDrift: "warn" })).toEqual([2]);
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0]?.[0]).toBeInstanceOf(MigrationDriftError);
    expect(recordedHash(db, 1)).toBe(before);
  });

  it("does not flag an unchanged migration", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [v1]);

    expect(runMigrations(db, [{ ...v1, up: (d) => d.exec(CREATE_T) }])).toEqual([]);
  });

  it("never compares a migration that declares no definition", () => {
    const db = openDatabase(":memory:");
    const bare: Migration = { version: 1, up: (d) => d.exec(CREATE_T) };
    runMigrations(db, [bare]);

    expect(recordedHash(db, 1)).toBeNull();
    expect(runMigrations(db, [{ ...bare, up: (d) => d.exec("CREATE TABLE IF NOT EXISTS t (a)") }])).toEqual([]);
  });

  it("opens a legacy table with no hash column and backfills the hash", () => {
    const db = legacyDatabase();

    expect(runMigrations(db, [v1])).toEqual([]);
    expect(appliedVersions(db)).toEqual([1]);
    expect(recordedHash(db, 1)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats a null recorded hash as unknown rather than drift", () => {
    const db = legacyDatabase();

    expect(runMigrations(db, [edited])).toEqual([]);
    expect(() => runMigrations(db, [v1])).toThrow(MigrationDriftError);
  });
});

describe("sqlMigration", () => {
  it("runs its sql, records a hash, and reports drift when the sql is edited", () => {
    const db = openDatabase(":memory:");
    const make = (sql: string) => sqlMigration({ version: 1, name: "create t", sql });

    expect(runMigrations(db, [make(CREATE_T)])).toEqual([1]);
    expect(recordedHash(db, 1)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => runMigrations(db, [make("CREATE TABLE t (a INTEGER, b TEXT)")])).toThrow(MigrationDriftError);
  });
});
