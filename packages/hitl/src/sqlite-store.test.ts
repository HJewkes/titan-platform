import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteGateStore, gateMigration, gateResolverMigration, gateRuleMigration } from "./sqlite-store.js";
import { GateStoreSchemaOutdated, type GateResolver, type GateRule } from "./types.js";

const OWNER: GateResolver = { class: "owner-terminal", id: "owner-fixture", channel: "test-cli" };
const REMOTE: GateResolver = { class: "owner-remote", id: "@owner:example.test", channel: "matrix", confirmEvent: "$evt1" };
const TERMINAL_ONLY: GateRule = { table: "F5", version: "1.0.0", ruleId: "REL-CO", resolvers: ["owner-terminal"] };

/** Verbatim from the 0.2.x SqliteGateStore, which predates `resolved_by`. */
const OLD_INSERT = `INSERT INTO "hitl_gate"
           (id, prompt, schema, status, payload, reason, created_at, resolved_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const OLD_UPDATE = `UPDATE "hitl_gate"
            SET status = ?, payload = ?, reason = ?, resolved_at = ?
          WHERE id = ?`;

const RAW_RESOLVE = `UPDATE "hitl_gate" SET status = 'resolved', payload = '"yes"', resolved_at = ?, resolved_by = ? WHERE id = ?`;

const RULE_JSON = JSON.stringify(TERMINAL_ONLY);
const RAW_INSERT = `INSERT INTO "hitl_gate" (id, resolved_at, resolved_by, rule, status, prompt, created_at)
  VALUES (?, ?, ?, ?, ?, 'release?', '2026-09-01T10:00:00.000Z')`;
const RAW_REPLACE = RAW_INSERT.replace("INSERT", "REPLACE");

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
  return columnCount(db, "resolved_by");
}

function columnCount(db: Db, column: string): number {
  const row = db.prepare("SELECT count(*) AS n FROM pragma_table_info('hitl_gate') WHERE name = ?").get(column) as {
    n: number;
  };
  return row.n;
}

function triggerNames(db: Db): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe("gateResolverMigration", () => {
  it("is idempotent when its step runs twice", () => {
    const db = v1Db();
    const migration = gateResolverMigration(2);
    migration.up(db);
    migration.up(db);
    expect(resolverColumnCount(db)).toBe(1);
    expect(triggerCount(db)).toBe(2);
  });

  it("succeeds on a table that already has the column", () => {
    const db = v1Db();
    db.exec(`ALTER TABLE "hitl_gate" ADD COLUMN resolved_by TEXT`);
    runMigrations(db, [gateMigration(1), gateResolverMigration(2)]);
    expect(resolverColumnCount(db)).toBe(1);
    expect(triggerCount(db)).toBe(2);
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

  it("is refused when it inserts a resolved row with no resolver", () => {
    const db = migratedWithLegacyRows();
    expect(() => oldInsert(db, "direct", "resolved", JSON.stringify("yes"))).toThrow("hitl: resolvedBy required");
    expect(db.prepare(`SELECT 1 FROM "hitl_gate" WHERE id = 'direct'`).get()).toBeUndefined();
    const store = new SqliteGateStore(db, { migrate: false });
    expect(store.create({ id: "fresh", prompt: "ship it?" }).status).toBe("pending");
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

describe("gateRuleMigration", () => {
  it("leaves one rule column and one trigger when its step runs twice", () => {
    const db = v1Db();
    const migration = gateRuleMigration(3);
    migration.up(db);
    migration.up(db);
    expect(columnCount(db, "rule")).toBe(1);
    expect(triggerNames(db)).toEqual(["hitl_gate_rule_replace", "hitl_gate_rule_resolver", "hitl_gate_rule_resolver_insert"]);
  });

  it("succeeds on a table that already has both columns and sits beside the resolver migration", () => {
    const db = v1Db();
    db.exec(`ALTER TABLE "hitl_gate" ADD COLUMN rule TEXT`);
    runMigrations(db, [gateMigration(1), gateResolverMigration(2), gateRuleMigration(3)]);
    expect(columnCount(db, "rule")).toBe(1);
    expect(triggerNames(db)).toEqual(["hitl_gate_resolver_required", "hitl_gate_resolver_required_insert", "hitl_gate_rule_replace", "hitl_gate_rule_resolver", "hitl_gate_rule_resolver_insert"]);
  });

  it("is run by migrate: true, so a default store holds a rule-bound gate it cannot resolve until the resolver migration", () => {
    const db = open();
    const store = new SqliteGateStore(db);
    store.create({ id: "g1", prompt: "release?", rule: TERMINAL_ONLY });
    expect(() => store.resolve("g1", "ok", REMOTE)).toThrow("does not let owner-remote resolve");
    expect(() => store.resolve("g1", "ok", OWNER)).toThrow(expect.objectContaining({ migration: "gateResolverMigration" }));
    runMigrations(db, [gateMigration(1), gateResolverMigration(2), gateRuleMigration(3)]);
    expect(store.resolve("g1", "ok", OWNER).rule).toEqual(TERMINAL_ONLY);
  });

  it.each([
    ["rule first", [gateMigration(1), gateRuleMigration(3), gateResolverMigration(4)]],
    ["resolver first", [gateMigration(1), gateResolverMigration(2), gateRuleMigration(3)]],
  ])("ends with the class-aware trigger whichever order it runs in beside the resolver migration (%s)", (_label, list) => {
    const db = open();
    runMigrations(db, list);
    const store = new SqliteGateStore(db, { migrate: false });
    store.create({ id: "g1", prompt: "release?", rule: TERMINAL_ONLY });
    expect(() => db.prepare(RAW_RESOLVE).run(T_SETTLED, JSON.stringify(REMOTE), "g1")).toThrow("hitl: resolver outside the gate rule");
    db.prepare(RAW_RESOLVE).run(T_SETTLED, JSON.stringify(OWNER), "g1");
    expect(store.get("g1")).toMatchObject({ status: "resolved", resolvedBy: OWNER });
  });
});

describe("an old writer against a rule-bound row on a table without the resolver column", () => {
  it("is refused when it resolves with the old SQL, and can still cancel", () => {
    const db = open();
    runMigrations(db, [gateMigration(1), gateRuleMigration(3)]);
    const store = new SqliteGateStore(db, { migrate: false });
    store.create({ id: "bound", prompt: "release?", rule: TERMINAL_ONLY });
    store.create({ id: "free", prompt: "ship it?" });
    expect(() => db.prepare(OLD_UPDATE).run("resolved", JSON.stringify("yes"), null, T_SETTLED, "bound")).toThrow(
      "hitl: resolver outside the gate rule",
    );
    db.prepare(OLD_UPDATE).run("resolved", JSON.stringify("yes"), null, T_SETTLED, "free");
    db.prepare(OLD_UPDATE).run("cancelled", null, "superseded", T_SETTLED, "bound");
    expect(store.get("bound")).toMatchObject({ status: "cancelled", rule: TERMINAL_ONLY });
    expect(store.get("free")?.status).toBe("resolved");
  });
});

describe("a store whose table predates the rule column", () => {
  it("refuses a rule-bound gate rather than dropping the rule, and inserts nothing", () => {
    const db = v1Db();
    const store = new SqliteGateStore(db, { migrate: false });
    expect(() => store.create({ id: "g1", prompt: "release?", rule: TERMINAL_ONLY })).toThrow(
      expect.objectContaining({ name: "GateStoreSchemaOutdated", gateId: "g1", table: "hitl_gate", migration: "gateRuleMigration" }),
    );
    expect(store.get("g1")).toBeUndefined();
    expect(store.create({ id: "g2", prompt: "ship it?" }).status).toBe("pending");
  });
});

describe("the rule trigger against raw SQL", () => {
  function ruleDb(): { db: Db; store: SqliteGateStore } {
    const db = open();
    runMigrations(db, [gateMigration(1), gateResolverMigration(2), gateRuleMigration(3)]);
    const store = new SqliteGateStore(db, { migrate: false });
    store.create({ id: "bound", prompt: "release?", rule: TERMINAL_ONLY });
    store.create({ id: "free", prompt: "ship it?" });
    return { db, store };
  }

  it("aborts a resolve of a rule-bound row by a class outside the rule", () => {
    const { db, store } = ruleDb();
    expect(() => db.prepare(RAW_RESOLVE).run(T_SETTLED, JSON.stringify(REMOTE), "bound")).toThrow(
      "hitl: resolver outside the gate rule",
    );
    expect(store.get("bound")).toMatchObject({ status: "pending", resolvedBy: undefined });
  });

  it("aborts a resolve of a rule-bound row that names no resolver", () => {
    const { db } = ruleDb();
    expect(() => db.prepare(RAW_RESOLVE).run(T_SETTLED, null, "bound")).toThrow("hitl: resolver outside the gate rule");
  });

  it("aborts an update that rewrites or clears the rule", () => {
    const { db, store } = ruleDb();
    const widened = JSON.stringify({ ...TERMINAL_ONLY, resolvers: ["owner-terminal", "owner-remote"] });
    expect(() => db.prepare(`UPDATE "hitl_gate" SET rule = ? WHERE id = 'bound'`).run(widened)).toThrow();
    expect(() => db.prepare(`UPDATE "hitl_gate" SET rule = NULL WHERE id = 'bound'`).run()).toThrow();
    expect(store.get("bound")?.rule).toEqual(TERMINAL_ONLY);
  });

  it("aborts REPLACE INTO of a rule-bound row as resolved by a class outside the rule", () => {
    const { db, store } = ruleDb();
    expect(() => db.prepare(RAW_REPLACE).run("bound", T_SETTLED, JSON.stringify(REMOTE), RULE_JSON, "resolved")).toThrow(
      "hitl: resolver outside the gate rule",
    );
    expect(store.get("bound")).toMatchObject({ status: "pending", rule: TERMINAL_ONLY });
  });

  it.each([
    ["REPLACE INTO", RAW_REPLACE],
    ["INSERT OR REPLACE", RAW_INSERT.replace("INSERT", "INSERT OR REPLACE")],
  ])("aborts %s of a pending rule-bound id with no rule, without recursive_triggers", (_label, sql) => {
    const { db, store } = ruleDb();
    expect(() => db.prepare(sql).run("bound", T_SETTLED, JSON.stringify(REMOTE), null, "resolved")).toThrow(
      "hitl: a pending rule-bound gate cannot be replaced",
    );
    expect(store.get("bound")).toMatchObject({ status: "pending", rule: TERMINAL_ONLY });
  });

  it("aborts REPLACE INTO of a pending rule-bound id with a different rule", () => {
    const { db, store } = ruleDb();
    const widened = JSON.stringify({ ...TERMINAL_ONLY, resolvers: ["owner-terminal", "owner-remote"] });
    expect(() => db.prepare(RAW_REPLACE).run("bound", T_SETTLED, JSON.stringify(REMOTE), widened, "resolved")).toThrow(
      "hitl: a pending rule-bound gate cannot be replaced",
    );
    expect(store.get("bound")?.rule).toEqual(TERMINAL_ONLY);
  });

  it("replaces a rule-less id freely, and a rule-bound id that is no longer pending", () => {
    const { db, store } = ruleDb();
    db.prepare(RAW_REPLACE).run("free", T_SETTLED, JSON.stringify(REMOTE), null, "resolved");
    db.prepare(OLD_UPDATE).run("cancelled", null, "superseded", T_SETTLED, "bound");
    db.prepare(RAW_REPLACE).run("bound", T_SETTLED, JSON.stringify(REMOTE), null, "resolved");
    expect(store.get("free")?.status).toBe("resolved");
    expect(store.get("bound")).toMatchObject({ status: "resolved", rule: undefined });
  });

  it("aborts an update that adds a rule to a rule-less row", () => {
    const { db, store } = ruleDb();
    expect(() => db.prepare(`UPDATE "hitl_gate" SET rule = ? WHERE id = 'free'`).run(RULE_JSON)).toThrow(
      "hitl: resolver outside the gate rule",
    );
    expect(store.get("free")?.rule).toBeUndefined();
  });

  it("aborts DELETE then INSERT of a rule-bound row as resolved by a class outside the rule", () => {
    const { db, store } = ruleDb();
    db.prepare(`DELETE FROM "hitl_gate" WHERE id = 'bound'`).run();
    expect(() => db.prepare(RAW_INSERT).run("bound", T_SETTLED, JSON.stringify(REMOTE), RULE_JSON, "resolved")).toThrow(
      "hitl: resolver outside the gate rule",
    );
    expect(store.get("bound")).toBeUndefined();
  });

  it("aborts an insert of a rule-bound resolved row that names no resolver", () => {
    const { db } = ruleDb();
    expect(() => db.prepare(RAW_INSERT).run("n1", T_SETTLED, null, RULE_JSON, "resolved")).toThrow();
  });

  it("admits a rule-bound resolved insert by a class the rule names, and a rule-less one by any class", () => {
    const { db, store } = ruleDb();
    db.prepare(RAW_INSERT).run("ok", T_SETTLED, JSON.stringify(OWNER), RULE_JSON, "resolved");
    db.prepare(RAW_INSERT).run("loose", T_SETTLED, JSON.stringify(REMOTE), null, "resolved");
    expect(store.get("ok")).toMatchObject({ status: "resolved", resolvedBy: OWNER });
    expect(store.get("loose")?.status).toBe("resolved");
  });

  it.each(["RESOLVED", "Resolved", "resolved "])("refuses a rule-bound insert or update with the non-canonical status %j", (status) => {
    const { db, store } = ruleDb();
    expect(() => db.prepare(RAW_INSERT).run("s1", T_SETTLED, JSON.stringify(REMOTE), RULE_JSON, status)).toThrow("hitl: status outside");
    expect(() => db.prepare(`UPDATE "hitl_gate" SET status = ? WHERE id = 'bound'`).run(status)).toThrow("hitl: status outside");
    expect(store.get("bound")?.status).toBe("pending");
  });

  it("leaves a row with no rule alone", () => {
    const { db, store } = ruleDb();
    db.prepare(RAW_RESOLVE).run(T_SETTLED, JSON.stringify(REMOTE), "free");
    expect(store.get("free")).toMatchObject({ status: "resolved", resolvedBy: REMOTE });
  });

  it("lets a rule-bound row be cancelled by the old SQL", () => {
    const { db, store } = ruleDb();
    db.prepare(OLD_UPDATE).run("cancelled", null, "superseded", T_SETTLED, "bound");
    expect(store.get("bound")).toMatchObject({ status: "cancelled", rule: TERMINAL_ONLY });
  });

  it.each([
    ["INSERT ON CONFLICT DO UPDATE", `${RAW_INSERT} ON CONFLICT(id) DO UPDATE SET prompt = excluded.prompt`],
    ["INSERT ON CONFLICT DO NOTHING", `${RAW_INSERT} ON CONFLICT(id) DO NOTHING`],
    ["INSERT OR IGNORE", RAW_INSERT.replace("INSERT", "INSERT OR IGNORE")],
    ["a plain duplicate INSERT", RAW_INSERT],
  ])("aborts %s of a pending rule-bound id with no rule, before conflict handling", (_label, sql) => {
    const { db, store } = ruleDb();
    expect(() => db.prepare(sql).run("bound", null, null, null, "pending")).toThrow(
      "hitl: a pending rule-bound gate cannot be replaced",
    );
    expect(store.get("bound")).toMatchObject({ status: "pending", rule: TERMINAL_ONLY });
  });

  it("lets a raw REPLACE turn a cancelled rule-bound row into a pending rule-less one, outside the store API", () => {
    const { db, store } = ruleDb();
    db.prepare(OLD_UPDATE).run("cancelled", null, "superseded", T_SETTLED, "bound");
    db.prepare(RAW_REPLACE).run("bound", null, null, null, "pending");
    expect(store.get("bound")).toMatchObject({ status: "pending", rule: undefined });
  });

  it("gives the store no path to a pending rule-less row under a cancelled rule-bound id", () => {
    const { db, store } = ruleDb();
    store.cancel("bound", "superseded");
    expect(() => store.create({ id: "bound", prompt: "release?" })).toThrow();
    expect(db.prepare(`SELECT count(*) AS n FROM "hitl_gate" WHERE id = 'bound'`).get()).toEqual({ n: 1 });
    expect(store.get("bound")).toMatchObject({ status: "cancelled", rule: TERMINAL_ONLY });
  });
});

describe("SqliteGateStore rule round trip", () => {
  it("keeps the rule across two stores on one file", () => {
    const dbPath = tempDbPath();
    runMigrations(open(dbPath), [gateMigration(1), gateResolverMigration(2), gateRuleMigration(3)]);
    const writer = new SqliteGateStore(open(dbPath), { migrate: false });
    writer.create({ id: "g1", prompt: "release?", rule: TERMINAL_ONLY });
    const reader = new SqliteGateStore(open(dbPath), { migrate: false });
    expect(reader.get("g1")?.rule).toEqual(TERMINAL_ONLY);
    expect(() => reader.resolve("g1", "ok", REMOTE)).toThrow("does not let owner-remote resolve");
  });
});
