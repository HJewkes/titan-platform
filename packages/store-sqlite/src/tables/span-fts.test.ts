import { describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../open.js";
import { SpanFtsTables, spanFtsTablesDdl } from "./span-fts.js";

function setup(): { db: Db; fts: SpanFtsTables } {
  const db = openDatabase(":memory:");
  db.exec(spanFtsTablesDdl());
  return { db, fts: new SpanFtsTables(db) };
}

const span = (owner: string, offset: number) => ({ ownerRef: owner, field: "prompt", sourceId: 1, byteOffset: offset, byteLength: 20 });

describe("SpanFtsTables", () => {
  it("indexes text without storing it and returns locators ranked by match", () => {
    const { db, fts } = setup();
    fts.index(span("session:a", 0), "fix the failing vitest suite");
    fts.index(span("session:b", 40), "deploy the worker to cloudflare");
    fts.index(span("session:c", 80), "vitest vitest vitest everywhere");

    const hits = fts.search("vitest");
    expect(hits.map((h) => h.ownerRef)).toEqual(["session:c", "session:a"]);
    expect(hits[0]).toMatchObject({ field: "prompt", sourceId: 1, byteOffset: 80, byteLength: 20 });
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'search_fts'").pluck().get()).toContain("content=''");
  });

  it("is idempotent for a re-indexed span", () => {
    const { fts } = setup();
    const first = fts.index(span("session:a", 0), "hello world");
    const second = fts.index(span("session:a", 0), "hello world");
    expect(second).toBe(first);
    expect(fts.search("hello")).toHaveLength(1);
  });

  it("hides stranded FTS rows after a purge and reports the orphan ratio", () => {
    const { fts } = setup();
    fts.index(span("session:a", 0), "alpha");
    fts.index(span("session:b", 1), "alpha");
    expect(fts.purgeOwner("session:a")).toBe(1);
    expect(fts.search("alpha").map((h) => h.ownerRef)).toEqual(["session:b"]);
    expect(fts.orphanRatio()).toBe(0.5);
    fts.clearIndex();
    expect(fts.search("alpha")).toEqual([]);
    expect(fts.orphanRatio()).toBe(0);
  });
});
