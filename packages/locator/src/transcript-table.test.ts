import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prefixHash } from "./hash.js";
import { emptyTable, resumePoint, transcriptIndexFor, type TranscriptEntry } from "./transcript-table.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "locator-table-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("transcriptIndexFor", () => {
  it("assigns stable, append-only indexes", () => {
    const table = emptyTable();
    expect(transcriptIndexFor(table, "a.jsonl")).toBe(0);
    expect(transcriptIndexFor(table, "b.jsonl")).toBe(1);
    expect(transcriptIndexFor(table, "a.jsonl")).toBe(0);
    expect(table.transcripts.map((t) => t.path)).toEqual(["a.jsonl", "b.jsonl"]);
  });
});

describe("resumePoint", () => {
  const entry = (lastByteOffset: number, hash: string | null = null): TranscriptEntry => ({
    path: "t.jsonl",
    lastByteOffset,
    prefixHash: hash,
  });

  it("reports unchanged at the watermark and appended past it", async () => {
    const file = path.join(dir, "t.jsonl");
    writeFileSync(file, "abc\n");
    expect(await resumePoint(entry(4), file)).toEqual({ state: "unchanged", start: 4, size: 4 });
    expect(await resumePoint(entry(2), file)).toEqual({ state: "appended", start: 2, size: 4 });
  });

  it("rewinds to zero when the file is shorter than the watermark", async () => {
    const file = path.join(dir, "t.jsonl");
    writeFileSync(file, "ab\n");
    expect(await resumePoint(entry(10), file)).toEqual({ state: "rewritten", start: 0, size: 3 });
  });

  it("detects a same-length rewrite only when asked to verify the hash", async () => {
    const file = path.join(dir, "t.jsonl");
    writeFileSync(file, "abc\n");
    const hash = await prefixHash(file, 4);
    writeFileSync(file, "xyz\n");
    expect((await resumePoint(entry(4, hash), file)).state).toBe("unchanged");
    expect((await resumePoint(entry(4, hash), file, { verifyHash: true })).state).toBe("rewritten");
  });

  it("reports a missing file instead of throwing", async () => {
    expect(await resumePoint(entry(4), path.join(dir, "gone.jsonl"))).toEqual({ state: "missing", start: 0, size: 0 });
  });
});
