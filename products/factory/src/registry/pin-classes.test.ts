import { describe, expect, it } from "vitest";
import { z } from "zod";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { markerTableMigration } from "../markers/marker-table.js";
import { PIN_CLASSES } from "./pin-classes.js";

function memory(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [markerTableMigration()]);
  return db;
}

function insertPinClass(db: Db, pinClass: string): void {
  const fact = pinClass === "landed" ? "landed" : "synthetic";
  db.prepare(
    `INSERT INTO factory_marker (item, fact, pin_class, pin, step, call_site, version, written_at)
     VALUES ('o/r#1', @fact, @pinClass, @pin, 'synthetic-step', 'synthetic:1', 'v1', '2026-11-01T00:00:00.000Z')`,
  ).run({ fact, pinClass, pin: `pin-${pinClass}` });
}

/** The classes the table's CHECK lists, read back from the schema SQLite stored. */
function checkSet(db: Db): string[] {
  const { sql } = z.object({ sql: z.string() }).parse(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'factory_marker'").get());
  const list = /pin_class IN \(([^)]*)\)/.exec(sql)?.[1] ?? "";
  return [...list.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? "").sort();
}

describe("pin-class rule file", () => {
  it("the rule file's pin classes equal the marker table's CHECK set", () => {
    const db = memory();
    for (const pinClass of PIN_CLASSES) expect(() => insertPinClass(db, pinClass)).not.toThrow();
    expect(() => insertPinClass(db, "epoch")).toThrow(/CHECK/);
    expect(checkSet(db)).toEqual([...PIN_CLASSES].sort());
  });
});
