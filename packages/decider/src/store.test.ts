import { describe, expect, it } from "vitest";
import { v1Row } from "./fixtures.js";
import { openLedgerStore } from "./store.js";

describe("LedgerStore", () => {
  it("writes a row once and ignores a second write under the same key", () => {
    const store = openLedgerStore(":memory:");

    const first = store.append([v1Row()]);
    const second = store.append([v1Row({ answer: "Use a cron job", pick_type: "other_option" })]);

    expect([first, second]).toEqual([1, 0]);
    expect(store.get(v1Row().key)?.outcome).toBe("accept");
  });

  it("reads rows back as parsed v2 shapes, filtered by initiative", () => {
    const store = openLedgerStore(":memory:");
    store.append([v1Row(), v1Row({ key: "note:other/a.md", source: "note", initiative: "other" })]);

    const rows = store.rows({ initiative: "widgets" });

    expect(rows.map((r) => [r.key, r.category, r.recommended])).toEqual([
      ["transcript:sess-0001:toolu_0001", "tech_design", "Use a queue"],
    ]);
    expect(store.count()).toBe(2);
  });

  it("lists entries in insertion order whatever their ask time, and a repeated key takes no new sequence", () => {
    const store = openLedgerStore(":memory:");
    store.append([v1Row({ key: "queue:new", asked_at: "2026-05-01T00:00:00Z" })]);
    store.append([v1Row({ key: "queue:new" }), v1Row({ key: "queue:old", asked_at: "2025-01-01T00:00:00Z" })]);

    const entries = store.entries();

    expect(entries.map((e) => e.row.key)).toEqual(["queue:new", "queue:old"]);
    expect(store.entries(entries[0]?.seq).map((e) => e.row.key)).toEqual(["queue:old"]);
  });

  it("refuses a malformed row without writing it", () => {
    const store = openLedgerStore(":memory:");

    expect(() => store.append([{ ...v1Row(), key: "" }])).toThrow();
    expect(store.count()).toBe(0);
  });

  it("keeps each source's watermarks apart", () => {
    const store = openLedgerStore(":memory:");

    store.advance("transcript", new Map([["/data/a.jsonl", { offset: 120, prefixHash: "h1" }]]));
    store.advance("note", new Map([["/data/a.jsonl", { offset: 7, prefixHash: null }]]));
    store.advance("transcript", new Map([["/data/a.jsonl", { offset: 240, prefixHash: "h2" }]]));

    expect(store.sourceWatermarks("transcript")).toEqual(
      new Map([["/data/a.jsonl", { offset: 240, prefixHash: "h2" }]]),
    );
    expect(store.sourceWatermarks("note").get("/data/a.jsonl")?.offset).toBe(7);
  });
});
