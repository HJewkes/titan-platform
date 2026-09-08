import { describe, expect, it } from "vitest";
import { openDatabase } from "../open.js";
import { EdgeTable, edgeTableDdl } from "./edge.js";

function setup(): EdgeTable {
  const db = openDatabase(":memory:");
  db.exec(edgeTableDdl());
  return new EdgeTable(db);
}

describe("EdgeTable", () => {
  it("asserts an edge once and treats an identical live edge as a no-op", () => {
    const edges = setup();
    expect(edges.assert({ sourceRef: "session:s1", relation: "touched", targetRef: "file:repo/a.ts" })).toBe(true);
    expect(edges.assert({ sourceRef: "session:s1", relation: "touched", targetRef: "file:repo/a.ts" })).toBe(false);
    expect(edges.from("session:s1")).toHaveLength(1);
    expect(edges.to("file:repo/a.ts")[0]?.sourceRef).toBe("session:s1");
  });

  it("expires instead of deleting, so history stays and live lookups hide the old row", () => {
    const edges = setup();
    edges.assert({ sourceRef: "a:1", relation: "r", targetRef: "b:1", attrs: { via: "test" } });
    expect(edges.expire("a:1", "r", "b:1", "2026-09-08T00:00:00.000Z")).toBe(true);
    expect(edges.expire("a:1", "r", "b:1")).toBe(false);
    expect(edges.current("a:1", "r", "b:1")).toBeUndefined();
    expect(edges.from("a:1")).toEqual([]);
  });

  it("supersedes a live edge with a corrected one and keeps both rows", () => {
    const edges = setup();
    edges.assert({ sourceRef: "a:1", relation: "r", targetRef: "b:1", confidence: 0.5 });
    edges.supersede({ sourceRef: "a:1", relation: "r", targetRef: "b:1", confidence: 0.9, factId: 7 });
    const live = edges.current("a:1", "r", "b:1");
    expect(live).toMatchObject({ confidence: 0.9, factId: 7, tExpired: null });
    expect(live?.edgeId).toBe(2);
  });

  it("round-trips attrs as JSON and defaults the timestamps", () => {
    const edges = setup();
    edges.assert({ sourceRef: "a:1", relation: "r", targetRef: "b:1", attrs: { n: 1, tags: ["x"] } });
    const row = edges.current("a:1", "r", "b:1");
    expect(row?.attrs).toEqual({ n: 1, tags: ["x"] });
    expect(row?.tValid).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row?.tCreated).toMatch(/Z$/);
  });

  it("supports a caller-chosen table name", () => {
    const db = openDatabase(":memory:");
    db.exec(edgeTableDdl({ name: "relations" }));
    const edges = new EdgeTable(db, { name: "relations" });
    edges.assert({ sourceRef: "a:1", relation: "r", targetRef: "b:1" });
    expect(db.prepare("SELECT count(*) AS n FROM relations").get()).toEqual({ n: 1 });
  });
});
