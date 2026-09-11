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

describe("SpanFtsTables scope", () => {
  /** Two classes of owner, one of them far larger, which is the situation scope exists for. */
  function crowded(): SpanFtsTables {
    const db = openDatabase(":memory:");
    db.exec(spanFtsTablesDdl());
    const fts = new SpanFtsTables(db);
    fts.index({ ownerRef: "note:a", field: "body", sourceId: 1, byteOffset: 0, byteLength: 10 }, "alpha note");
    fts.index({ ownerRef: "note:b", field: "title", sourceId: 1, byteOffset: 10, byteLength: 10 }, "alpha title");
    for (let i = 0; i < 40; i++) {
      fts.index({ ownerRef: `session:s${i}`, field: "tool_result", sourceId: 2, byteOffset: i * 10, byteLength: 10 }, "alpha alpha alpha");
    }
    // Same `session:` prefix as the transcript spans above, different field.
    fts.index({ ownerRef: "session:s0", field: "body", sourceId: 3, byteOffset: 0, byteLength: 10 }, "alpha record");
    return fts;
  }

  it("returns one class's own top-N rather than what survives a global top-N", () => {
    const fts = crowded();
    // Unscoped, the 40 transcript spans outrank both notes and crowd them out.
    expect(fts.search("alpha", 5).every((h) => h.ownerRef.startsWith("session:"))).toBe(true);

    const notes = fts.search("alpha", 5, { ownerPrefix: "note:" });
    expect(notes.map((h) => h.ownerRef).sort()).toEqual(["note:a", "note:b"]);
  });

  it("separates two classes that share an owner prefix, which a prefix alone cannot", () => {
    // active-work keys a mined transcript and a workspace session record both
    // under `session:`. Prefix-only, the record is buried under 40 transcripts.
    const fts = crowded();

    const records = fts.search("alpha", 10, { ownerPrefix: "session:", fields: ["body"] });
    expect(records.map((h) => h.ownerRef)).toEqual(["session:s0"]);
    expect(records[0]!.sourceId).toBe(3);

    const transcripts = fts.search("alpha", 50, { ownerPrefix: "session:", fields: ["tool_result"] });
    expect(transcripts).toHaveLength(40);
    expect(transcripts.every((h) => h.field === "tool_result")).toBe(true);
  });

  it("treats fields and prefix as independent, and an empty field list as matching nothing", () => {
    const fts = crowded();

    expect(fts.search("alpha", 50, { fields: ["title"] }).map((h) => h.ownerRef)).toEqual(["note:b"]);
    expect(fts.search("alpha", 50, { fields: [] })).toEqual([]);
    // An empty prefix means every owner, which is what omitting it already means.
    expect(fts.search("alpha", 50, { ownerPrefix: "" })).toHaveLength(43);
  });

  it("does not let a prefix bleed into the next class", () => {
    const db = openDatabase(":memory:");
    db.exec(spanFtsTablesDdl());
    const fts = new SpanFtsTables(db);
    // `note:` and `notebook:` share a prefix up to the colon; a sloppy range
    // upper bound would return both.
    fts.index({ ownerRef: "note:a", field: "body", sourceId: 1, byteOffset: 0, byteLength: 5 }, "alpha");
    fts.index({ ownerRef: "notebook:a", field: "body", sourceId: 1, byteOffset: 5, byteLength: 5 }, "alpha");

    expect(fts.search("alpha", 10, { ownerPrefix: "note:" }).map((h) => h.ownerRef)).toEqual(["note:a"]);
    expect(fts.search("alpha", 10, { ownerPrefix: "note" }).map((h) => h.ownerRef).sort()).toEqual(["note:a", "notebook:a"]);
  });

  it("reuses one prepared statement per scope shape, not per query", () => {
    const fts = crowded();
    const statements = () => (fts as unknown as { scopedSearchStmts: Map<string, unknown> }).scopedSearchStmts.size;

    fts.search("alpha", 5, { ownerPrefix: "note:" });
    fts.search("beta", 5, { ownerPrefix: "session:" });
    expect(statements()).toBe(1);

    fts.search("alpha", 5, { ownerPrefix: "session:", fields: ["body"] });
    expect(statements()).toBe(2);
  });
});
