import { describe, expect, it } from "vitest";
import { openDatabase } from "../open.js";
import { EntityTable, entitySnapTableDdl, entityTableDdl, snapshotTableDdl } from "./entity.js";

describe("EntityTable (interval)", () => {
  it("upserts by ref, lists live rows by kind, and revives an expired ref on upsert", () => {
    const db = openDatabase(":memory:");
    db.exec(entityTableDdl());
    const entities = new EntityTable(db);
    entities.upsert({ ref: "note:1", kind: "note", name: "first", attrs: { tags: ["a"] } });
    entities.upsert({ ref: "note:2", kind: "note", name: "second", parentRef: "note:1" });
    expect(entities.listByKind("note").map((e) => e.name)).toEqual(["first", "second"]);

    expect(entities.expire("note:1")).toBe(true);
    expect(entities.listByKind("note").map((e) => e.ref)).toEqual(["note:2"]);
    expect(entities.get("note:1")?.tExpired).not.toBeNull();

    entities.upsert({ ref: "note:1", kind: "note", name: "first again" });
    expect(entities.get("note:1")).toMatchObject({ name: "first again", tExpired: null, attrs: null });
  });
});

describe("snapshot-scoped DDL", () => {
  it("creates the snapshot registry and a snapshot-keyed entity table", () => {
    const db = openDatabase(":memory:");
    db.exec(snapshotTableDdl() + entitySnapTableDdl({ name: "node" }));
    const { lastInsertRowid } = db.prepare("INSERT INTO snapshot (ref) VALUES ('head')").run();
    db.prepare("INSERT INTO node (snapshot_id, id, kind) VALUES (?, 'src/a.ts', 'file')").run(lastInsertRowid);
    db.prepare("INSERT INTO node (snapshot_id, id, kind) VALUES (?, 'src/a.ts', 'file')").run(2);
    expect(() =>
      db.prepare("INSERT INTO node (snapshot_id, id, kind) VALUES (?, 'src/a.ts', 'file')").run(lastInsertRowid),
    ).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(db.prepare("SELECT count(*) AS n FROM node").get()).toEqual({ n: 2 });
  });
});
