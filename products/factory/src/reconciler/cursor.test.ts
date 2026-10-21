import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { reconcilerCursorMigration, sqliteReconcilerCursor } from "./cursor.js";

const AT = Date.parse("2027-01-15T08:00:00.000Z");

function store() {
  const db = openDatabase(":memory:");
  runMigrations(db, [reconcilerCursorMigration()]);
  return { db, cursor: sqliteReconcilerCursor(db, () => AT) };
}

describe("reconciler cursor", () => {
  it("reads back each stream written for a repo, with when it moved, and nothing for another repo", () => {
    const { cursor } = store();

    cursor.write("example-org/widgets", { main: "c2", done: "2027-01-15T07:30:00Z" });

    expect(cursor.read("example-org/widgets")).toEqual({ main: { value: "c2", at: "2027-01-15T08:00:00.000Z" }, done: { value: "2027-01-15T07:30:00Z", at: "2027-01-15T08:00:00.000Z" } });
    expect(cursor.read("example-org/gadgets")).toEqual({});
  });

  it("moves every stream of one write together, or none when one is refused", () => {
    const { db, cursor } = store();
    cursor.write("example-org/widgets", { main: "c1" });
    db.exec("CREATE TRIGGER refuse_done BEFORE INSERT ON factory_reconciler_cursor WHEN NEW.stream = 'done' BEGIN SELECT RAISE(ABORT, 'synthetic refusal'); END;");

    expect(() => cursor.write("example-org/widgets", { main: "c2", done: "2027-01-15T07:30:00Z" })).toThrow("synthetic refusal");

    expect(cursor.read("example-org/widgets")).toEqual({ main: { value: "c1", at: "2027-01-15T08:00:00.000Z" } });
  });

  it("refuses a stream the table does not know", () => {
    const { db } = store();

    expect(() => db.prepare("INSERT INTO factory_reconciler_cursor VALUES ('example-org/widgets', 'tip', 'c1', 'x')").run()).toThrow(/CHECK/);
  });
});
