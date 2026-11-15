import { describe, expect, it } from "vitest";
import { kitDdl, kitMigration } from "./kit.js";
import { runMigrations } from "./migrations.js";
import { hasTable, openDatabase } from "./open.js";
import { EdgeTable } from "./tables/edge.js";
import { WatermarkTable } from "./tables/watermark.js";

describe("kit selection", () => {
  it("installs only the selected tables, honoring name overrides, as a migration", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [kitMigration(1, { edge: "relations", watermark: true, spanFts: "notes" })]);
    expect(hasTable(db, "relations")).toBe(true);
    expect(hasTable(db, "watermark")).toBe(true);
    expect(hasTable(db, "notes_span")).toBe(true);
    expect(hasTable(db, "notes_fts")).toBe(true);
    expect(hasTable(db, "entity")).toBe(false);
    expect(hasTable(db, "cache_blob")).toBe(false);

    new EdgeTable(db, { name: "relations" }).assert({ sourceRef: "a:1", relation: "r", targetRef: "b:1" });
    expect(new WatermarkTable(db).ensure("src").sourceId).toBe(1);
  });

  it("emits idempotent DDL that can be applied twice", () => {
    const db = openDatabase(":memory:");
    const ddl = kitDdl({ snapshot: true, entitySnap: true, entity: true, edge: true, cacheBlob: true, spanFts: true, watermark: true });
    db.exec(ddl);
    expect(() => db.exec(ddl)).not.toThrow();
    for (const t of ["snapshot", "entity_snap", "entity", "edge", "cache_blob", "search_span", "search_fts", "watermark"]) {
      expect(hasTable(db, t), t).toBe(true);
    }
  });

  it("creates the trigram twin only when spanFtsTrigram is selected", () => {
    const withTwin = openDatabase(":memory:");
    withTwin.exec(kitDdl({ spanFts: "notes", spanFtsTrigram: true }));
    expect(hasTable(withTwin, "notes_tri")).toBe(true);

    const without = openDatabase(":memory:");
    without.exec(kitDdl({ spanFts: "notes" }));
    expect(hasTable(without, "notes_tri")).toBe(false);
  });

  it("rejects a trigram twin with no span FTS tables to attach to", () => {
    expect(() => kitDdl({ spanFtsTrigram: true })).toThrow(/spanFtsTrigram needs spanFts/);
  });

  it("rejects unsafe table names", () => {
    expect(() => kitDdl({ edge: "bad name; DROP TABLE x" })).toThrow(/invalid SQL identifier/);
  });
});
