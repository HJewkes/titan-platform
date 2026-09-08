import { describe, expect, it } from "vitest";
import { openDatabase } from "../open.js";
import { WatermarkTable, watermarkTableDdl } from "./watermark.js";

function setup(): WatermarkTable {
  const db = openDatabase(":memory:");
  db.exec(watermarkTableDdl());
  return new WatermarkTable(db);
}

describe("WatermarkTable", () => {
  it("creates a source at offset 0 with a stable id and advances it", () => {
    const wm = setup();
    const row = wm.ensure("~/.claude/projects/x/a.jsonl");
    expect(row).toMatchObject({ sourceId: 1, lastOffset: 0, status: "ok", prefixHash: null });
    expect(wm.ensure("~/.claude/projects/x/a.jsonl").sourceId).toBe(1);
    expect(wm.ensure("other").sourceId).toBe(2);

    wm.advance("~/.claude/projects/x/a.jsonl", { lastOffset: 512, prefixHash: "abc", fileSize: 600, contentHash: "full" });
    expect(wm.get("~/.claude/projects/x/a.jsonl")).toMatchObject({ lastOffset: 512, prefixHash: "abc", fileSize: 600, contentHash: "full" });
    expect(wm.get("~/.claude/projects/x/a.jsonl")?.lastIndexedAt).toMatch(/Z$/);
  });

  it("keeps a stored content hash when an advance omits it", () => {
    const wm = setup();
    wm.ensure("s");
    wm.advance("s", { lastOffset: 1, contentHash: "keep-me" });
    wm.advance("s", { lastOffset: 2 });
    expect(wm.get("s")?.contentHash).toBe("keep-me");
  });

  it("records status with a reason, and advancing clears it", () => {
    const wm = setup();
    wm.ensure("s");
    wm.markStatus("s", "hash_mismatch", "prefix changed");
    expect(wm.get("s")).toMatchObject({ status: "hash_mismatch", statusReason: "prefix changed" });
    wm.advance("s", { lastOffset: 3 });
    expect(wm.get("s")).toMatchObject({ status: "ok", statusReason: null });
  });

  it("rewinds to zero and lists sources in creation order", () => {
    const wm = setup();
    wm.ensure("b");
    wm.ensure("a");
    wm.advance("b", { lastOffset: 10, prefixHash: "h" });
    wm.rewind("b");
    expect(wm.get("b")).toMatchObject({ lastOffset: 0, prefixHash: null });
    expect(wm.list().map((r) => r.sourceKey)).toEqual(["b", "a"]);
  });
});
