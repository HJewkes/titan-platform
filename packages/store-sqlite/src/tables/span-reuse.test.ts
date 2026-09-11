import { describe, expect, it } from "vitest";
import { openDatabase } from "../open.js";
import { SpanFtsTables, spanFtsTablesDdl } from "./span-fts.js";

describe("contentless FTS replacement", () => {
  it("never resurrects purged words when replacing the highest span id", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec(spanFtsTablesDdl());
      const spans = new SpanFtsTables(db);
      const locator = { ownerRef: "conversation:test", field: "prompt", sourceId: 1, byteOffset: 0, byteLength: 42 };
      const old = spans.index(locator, "obsoleteword");
      spans.purgeOwner(locator.ownerRef);
      const fresh = spans.index(locator, "replacementword");
      expect(fresh).toBeGreaterThan(old);
      expect(spans.search("obsoleteword")).toEqual([]);
      expect(spans.search("replacementword")).toHaveLength(1);
    } finally { db.close(); }
  });
});
