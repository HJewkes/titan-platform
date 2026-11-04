import { describe, expect, it } from "vitest";
import { appliedVersions, openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { markerTableMigration } from "./marker-table.js";

const AT = "2026-11-01T12:00:00.000Z";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const LIMIT = 256 * 1024;

interface MarkerInput {
  item?: string;
  fact?: string;
  pin_class?: string;
  pin?: string;
  pin_seq?: number | null;
  expires_at?: string | null;
  reverted?: number;
}

function memory(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [markerTableMigration()]);
  return db;
}

function insertMarker(db: Db, overrides: MarkerInput = {}): number {
  const row = { item: "o/r#7", fact: "ci", pin_class: "tree", pin: SHA_A, pin_seq: 1, expires_at: null, reverted: 0, ...overrides };
  const result = db
    .prepare(
      `INSERT INTO factory_marker (item, fact, pin_class, pin, pin_seq, expires_at, step, call_site, version, reverted, written_at)
       VALUES (@item, @fact, @pin_class, @pin, @pin_seq, @expires_at, 'check-ci', 'land:1', 'v1', @reverted, '${AT}')`,
    )
    .run(row);
  return Number(result.lastInsertRowid);
}

function current(db: Db, identity: Required<Pick<MarkerInput, "item" | "fact" | "pin_class" | "pin">>): unknown {
  return db.prepare("SELECT MAX(id) AS id FROM factory_marker WHERE item = @item AND fact = @fact AND pin_class = @pin_class AND pin = @pin").get(identity);
}

function insertBlob(db: Db, blob: { bytes: number; inline: Buffer | null; path: string | null }): void {
  db.prepare(`INSERT INTO factory_marker_blob (digest, bytes, inline, path, created_at) VALUES ('sha256:x', @bytes, @inline, @path, '${AT}')`).run(blob);
}

const count = (db: Db): unknown => db.prepare("SELECT COUNT(*) AS n FROM factory_marker").get();

describe("marker table migration", () => {
  it("registers as version 49", () => {
    expect(appliedVersions(memory())).toContain(49);
  });
});

describe("marker identity and supersession", () => {
  it("a marker row refuses UPDATE and DELETE", () => {
    const db = memory();
    const id = insertMarker(db);

    expect(() => db.prepare("UPDATE factory_marker SET version = 'v2' WHERE id = ?").run(id)).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM factory_marker WHERE id = ?").run(id)).toThrow(/append-only/);
    expect(db.prepare("SELECT version FROM factory_marker WHERE id = ?").get(id)).toEqual({ version: "v1" });
  });

  it("a marker row refuses INSERT OR REPLACE over its id", () => {
    const db = memory();
    const id = insertMarker(db);

    const replace = (): unknown =>
      db.prepare(`INSERT OR REPLACE INTO factory_marker (id, item, fact, pin_class, pin, step, call_site, version, written_at) VALUES (?, 'o/r#7', 'ci', 'tree', 'x', 's', 'c', 'v9', '${AT}')`).run(id);

    expect(replace).toThrow(/append-only/);
    expect(db.prepare("SELECT version FROM factory_marker WHERE id = ?").get(id)).toEqual({ version: "v1" });
  });

  it("a second marker at the same (item, fact, pin) keeps the first row and the newer id is current", () => {
    const db = memory();
    const first = insertMarker(db);

    const second = insertMarker(db);

    expect(second).toBeGreaterThan(first);
    expect(count(db)).toEqual({ n: 2 });
    expect(current(db, { item: "o/r#7", fact: "ci", pin_class: "tree", pin: SHA_A })).toEqual({ id: second });
  });

  it("a marker at a new tree epoch is a new identity beside the old one", () => {
    const db = memory();
    const old = insertMarker(db, { pin: SHA_A, pin_seq: 1 });

    const moved = insertMarker(db, { pin: SHA_B, pin_seq: 2 });

    expect(current(db, { item: "o/r#7", fact: "ci", pin_class: "tree", pin: SHA_A })).toEqual({ id: old });
    expect(current(db, { item: "o/r#7", fact: "ci", pin_class: "tree", pin: SHA_B })).toEqual({ id: moved });
  });
});

describe("reverted is terminal", () => {
  const landed = { fact: "landed", pin_class: "landed", pin: "tree^{tree}|merge-op:1", reverted: 1 };

  it("an item with a reverted landed marker refuses any further marker, on any fact", () => {
    const db = memory();
    insertMarker(db, landed);

    expect(() => insertMarker(db, { fact: "ci" })).toThrow(/reverted item is terminal/);
    expect(() => insertMarker(db, { ...landed, reverted: 0 })).toThrow(/reverted item is terminal/);
    expect(() => insertMarker(db, landed)).toThrow(/reverted item is terminal/);
    expect(count(db)).toEqual({ n: 1 });
  });

  it("a reverted item leaves other items free to take markers", () => {
    const db = memory();
    insertMarker(db, landed);

    insertMarker(db, { item: "o/r#8" });

    expect(count(db)).toEqual({ n: 2 });
  });

  it("reverted is refused on a fact other than landed", () => {
    const db = memory();

    expect(() => insertMarker(db, { fact: "ci", pin_class: "landed", reverted: 1 })).toThrow(/CHECK constraint/);
    expect(() => insertMarker(db, { fact: "landed", pin_class: "tree", reverted: 1 })).toThrow(/CHECK constraint/);
    expect(count(db)).toEqual({ n: 0 });
  });
});

describe("marker column checks", () => {
  it("expires_at is refused outside the observed class", () => {
    const db = memory();

    expect(() => insertMarker(db, { pin_class: "tree", expires_at: AT })).toThrow(/CHECK constraint/);
    insertMarker(db, { pin_class: "observed", pin: "ttl", expires_at: AT });
    expect(count(db)).toEqual({ n: 1 });
  });

  it("a pin class outside the five is refused", () => {
    const db = memory();

    expect(() => insertMarker(db, { pin_class: "branch" })).toThrow(/CHECK constraint/);
  });

  it("an out-of-line blob row needs more than 256 KB, and an inline one needs no path", () => {
    const db = memory();

    expect(() => insertBlob(db, { bytes: LIMIT, inline: null, path: "ab/cd" })).toThrow(/CHECK constraint/);
    expect(() => insertBlob(db, { bytes: 3, inline: Buffer.from("abc"), path: "ab/cd" })).toThrow(/CHECK constraint/);
    expect(() => insertBlob(db, { bytes: 3, inline: null, path: null })).toThrow(/CHECK constraint/);
    insertBlob(db, { bytes: LIMIT + 1, inline: null, path: "ab/cd" });
    expect(db.prepare("SELECT bytes, path FROM factory_marker_blob").all()).toEqual([{ bytes: LIMIT + 1, path: "ab/cd" }]);
  });

  it("a blob a marker names as its output can be collected while the marker row stays", () => {
    const db = memory();
    insertBlob(db, { bytes: 3, inline: Buffer.from("abc"), path: null });
    db.prepare(`INSERT INTO factory_marker (item, fact, pin_class, pin, step, call_site, version, output_digest, written_at) VALUES ('o/r#7', 'ci', 'tree', 'x', 's', 'c', 'v1', 'sha256:x', '${AT}')`).run();

    db.prepare("DELETE FROM factory_marker_blob WHERE digest = 'sha256:x'").run();

    expect(db.prepare("SELECT output_digest FROM factory_marker").all()).toEqual([{ output_digest: "sha256:x" }]);
  });

  it("an eval root must name an existing marker", () => {
    const db = memory();
    const id = insertMarker(db);
    const addRoot = (markerId: number): unknown => db.prepare(`INSERT INTO factory_marker_root (marker_id, kind, reason, added_at) VALUES (?, 'eval', 'corpus', '${AT}')`).run(markerId);

    addRoot(id);

    expect(() => addRoot(id + 1)).toThrow(/FOREIGN KEY/);
  });
});
