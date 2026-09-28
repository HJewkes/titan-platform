import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteGateStore, gateMigration, gateResolverMigration } from "./sqlite-store.js";
import { GateStoreSchemaOutdated, type GateResolver } from "./types.js";

const OWNER: GateResolver = { class: "owner-terminal", id: "owner-fixture", channel: "test-cli" };
const REMOTE: GateResolver = { class: "owner-remote", id: "@owner:example.test", channel: "matrix", confirmEvent: "$evt1" };

/** Verbatim from the 0.2.x SqliteGateStore, which predates `resolved_by`. */
const OLD_INSERT = `INSERT INTO "hitl_gate"
           (id, prompt, schema, status, payload, reason, created_at, resolved_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const OLD_UPDATE = `UPDATE "hitl_gate"
            SET status = ?, payload = ?, reason = ?, resolved_at = ?
          WHERE id = ?`;

const T_CREATED = "2026-09-01T10:00:00.000Z";
const T_SETTLED = "2026-09-01T11:00:00.000Z";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hitl-sqlite-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "gates.sqlite3");
}

function open(dbPath: string = tempDbPath()): Db {
  const db = openDatabase(dbPath);
  cleanups.push(() => db.close());
  return db;
}

function v1Db(dbPath?: string): Db {
  const db = open(dbPath);
  runMigrations(db, [gateMigration(1)]);
  return db;
}

function oldInsert(db: Db, id: string, status = "pending", payload: string | null = null): void {
  const resolvedAt = status === "pending" ? null : T_SETTLED;
  db.prepare(OLD_INSERT).run(id, "legacy?", null, status, payload, null, T_CREATED, resolvedAt, null);
}

function rawRow(db: Db, id: string): Record<string, unknown> {
  return db.prepare(`SELECT * FROM "hitl_gate" WHERE id = ?`).get(id) as Record<string, unknown>;
}

function triggerCount(db: Db): number {
  const row = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'").get() as { n: number };
  return row.n;
}

function resolverColumnCount(db: Db): number {
  const row = db.prepare("SELECT count(*) AS n FROM pragma_table_info('hitl_gate') WHERE name = 'resolved_by'").get() as {
    n: number;
  };
  return row.n;
}

describe("gateResolverMigration", () => {
  it("is idempotent when its step runs twice", () => {
    const db = v1Db();
    const migration = gateResolverMigration(2);
    migration.up(db);
    migration.up(db);
    expect(resolverColumnCount(db)).toBe(1);
    expect(triggerCount(db)).toBe(1);
  });

  it("succeeds on a table that already has the column", () => {
    const db = v1Db();
    db.exec(`ALTER TABLE "hitl_gate" ADD COLUMN resolved_by TEXT`);
    runMigrations(db, [gateMigration(1), gateResolverMigration(2)]);
    expect(resolverColumnCount(db)).toBe(1);
    expect(triggerCount(db)).toBe(1);
  });

  it("takes its version from the product's list and names itself after the table", () => {
    const dbPath = tempDbPath();
    const db = open(dbPath);
    const productTable = { version: 2, name: "product:things", up: (d: Db) => d.exec("CREATE TABLE things (id TEXT)") };
    runMigrations(db, [gateMigration(1), productTable, gateResolverMigration(4)]);
    const recorded = db.prepare("SELECT version, name FROM _migration ORDER BY version").all();
    expect(recorded).toEqual([
      { version: 1, name: "hitl:hitl_gate" },
      { version: 2, name: "product:things" },
      { version: 4, name: "hitl:resolver:hitl_gate" },
    ]);
    const reopened = new SqliteGateStore(open(dbPath), { migrate: false });
    reopened.create({ id: "g1", prompt: "ship it?" });
    expect(reopened.resolve("g1", "ok", OWNER).resolvedBy).toEqual(OWNER);
  });

  it("leaves gates resolved before it with an unknown resolver and does not rewrite them", () => {
    const db = v1Db();
    oldInsert(db, "legacy", "resolved", JSON.stringify({ approved: true }));
    const before = rawRow(db, "legacy");
    runMigrations(db, [gateMigration(1), gateResolverMigration(2)]);
    expect(rawRow(db, "legacy")).toEqual({ ...before, resolved_by: null });
    const store = new SqliteGateStore(db, { migrate: false });
    expect(store.get("legacy")).toMatchObject({ status: "resolved", payload: { approved: true }, resolvedBy: undefined });
  });
});

describe("an old writer against a migrated table", () => {
  function migratedWithLegacyRows(): Db {
    const db = v1Db();
    oldInsert(db, "legacy", "resolved", JSON.stringify("yes"));
    oldInsert(db, "p1");
    oldInsert(db, "p2");
    oldInsert(db, "p3");
    runMigrations(db, [gateMigration(1), gateResolverMigration(2)]);
    return db;
  }

  it("is refused when it resolves with the old SQL", () => {
    const db = migratedWithLegacyRows();
    expect(() => db.prepare(OLD_UPDATE).run("resolved", JSON.stringify("yes"), null, T_SETTLED, "p1")).toThrow(
      "hitl: resolvedBy required",
    );
    expect(rawRow(db, "p1")).toMatchObject({ status: "pending", resolved_by: null });
  });

  it("still cancels with the old SQL", () => {
    const db = migratedWithLegacyRows();
    db.prepare(OLD_UPDATE).run("cancelled", null, "superseded", T_SETTLED, "p1");
    expect(rawRow(db, "p1")).toMatchObject({ status: "cancelled", reason: "superseded", resolved_by: null });
  });

  it("still inserts pending gates with the old SQL", () => {
    const db = migratedWithLegacyRows();
    oldInsert(db, "p4");
    expect(new SqliteGateStore(db, { migrate: false }).get("p4")).toMatchObject({ status: "pending" });
  });

  it("cannot disturb a resolver the new writer recorded on another gate", () => {
    const db = migratedWithLegacyRows();
    const store = new SqliteGateStore(db, { migrate: false });
    store.resolve("p1", "yes", REMOTE);
    db.prepare(OLD_UPDATE).run("cancelled", null, "superseded", T_SETTLED, "p2");
    expect(() => db.prepare(OLD_UPDATE).run("resolved", null, null, T_SETTLED, "p3")).toThrow();
    expect(store.get("p1")?.resolvedBy).toEqual(REMOTE);
    expect(store.get("legacy")?.resolvedBy).toBeUndefined();
  });

  it("refuses the new store's own anonymous resolve through the trigger", () => {
    const db = migratedWithLegacyRows();
    const store = new SqliteGateStore(db, { migrate: false });
    expect(() => store.resolve("p1", "yes")).toThrow("hitl: resolvedBy required");
    expect(store.get("p1")).toMatchObject({ status: "pending", resolvedBy: undefined });
  });
});

describe("a store whose table predates the resolver column", () => {
  it("still resolves when no resolver is given", () => {
    const store = new SqliteGateStore(v1Db(), { migrate: false });
    store.create({ id: "g1", prompt: "ship it?" });
    expect(store.resolve("g1", "ok")).toMatchObject({ status: "resolved", resolvedBy: undefined });
    expect(store.get("g1")).toMatchObject({ status: "resolved", payload: "ok", resolvedBy: undefined });
  });

  it("refuses a resolver rather than dropping it, and leaves the gate pending", () => {
    const store = new SqliteGateStore(v1Db(), { migrate: false });
    store.create({ id: "g1", prompt: "ship it?" });
    expect(() => store.resolve("g1", "ok", OWNER)).toThrow(GateStoreSchemaOutdated);
    expect(store.get("g1")).toMatchObject({ status: "pending", payload: undefined });
  });

  it("names the gate, the table and the migration it needs", () => {
    const store = new SqliteGateStore(v1Db(), { migrate: false });
    store.create({ id: "g1", prompt: "ship it?" });
    expect(() => store.resolve("g1", "ok", OWNER)).toThrow(
      expect.objectContaining({ gateId: "g1", table: "hitl_gate", migration: "gateResolverMigration" }),
    );
  });

  it("records the resolver once the migration runs after the store was built", () => {
    const db = v1Db();
    const store = new SqliteGateStore(db, { migrate: false });
    store.create({ id: "g1", prompt: "ship it?" });
    runMigrations(db, [gateMigration(1), gateResolverMigration(2)]);
    expect(store.resolve("g1", "ok", OWNER).resolvedBy).toEqual(OWNER);
  });

  it("is what migrate: true still builds, so an existing default store keeps resolving anonymously", () => {
    const db = open();
    const store = new SqliteGateStore(db);
    store.create({ id: "g1", prompt: "ship it?" });
    expect(store.resolve("g1", "ok").status).toBe("resolved");
    expect(resolverColumnCount(db)).toBe(0);
  });
});

describe("SqliteGateStore resolver round trip", () => {
  it("keeps resolvedBy, including confirmEvent, across two stores on one file", () => {
    const dbPath = tempDbPath();
    runMigrations(open(dbPath), [gateMigration(1), gateResolverMigration(2)]);
    const writer = new SqliteGateStore(open(dbPath), { migrate: false });
    writer.create({ id: "g1", prompt: "ship it?" });
    writer.resolve("g1", { approved: true }, REMOTE);
    const reader = new SqliteGateStore(open(dbPath), { migrate: false });
    expect(reader.get("g1")?.resolvedBy).toEqual(REMOTE);
  });
});
