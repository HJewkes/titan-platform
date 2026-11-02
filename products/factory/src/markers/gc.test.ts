import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { getBlob, putBlob, type BlobStore } from "./blob-store.js";
import { collectMarkerBlobs, DEFAULT_RETAIN_LANDED_DAYS } from "./gc.js";
import { readMarkerValues, writeMarker, type MarkerInput } from "./marker-store.js";
import { INLINE_LIMIT_BYTES, markerTableMigration } from "./marker-table.js";

const LANDED_AT = "2026-11-01T12:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;
const afterDays = (days: number): Date => new Date(Date.parse(LANDED_AT) + days * DAY_MS);
const PAST_RETENTION = DEFAULT_RETAIN_LANDED_DAYS + 1;
const INSIDE_RETENTION = DEFAULT_RETAIN_LANDED_DAYS - 1;
const OPEN = "o/r#1";
const CLOSED = "o/r#2";

let dir: string;
let db: Db;
let store: BlobStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marker-gc-"));
  db = openDatabase(join(dir, "factory.db"));
  runMigrations(db, [markerTableMigration()]);
  store = { blobDir: join(dir, "marker-blobs"), capabilities: { refuse: () => undefined } };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const text = (value: string): Buffer => Buffer.from(value);
const large = (fill: number): Buffer => Buffer.alloc(INLINE_LIMIT_BYTES + 1, fill);
const digestOf = (bytes: Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const files = (): string[] => {
  try {
    return readdirSync(store.blobDir);
  } catch {
    return [];
  }
};
const count = (table: string): number => db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;

function write(overrides: Partial<MarkerInput>): number {
  return writeMarker(db, store, {
    item: OPEN,
    fact: "ci",
    pinClass: "tree",
    pin: "a".repeat(40),
    step: "check-ci",
    callSite: "land:1",
    version: "v1",
    inputDigests: {},
    reads: [],
    writtenAt: LANDED_AT,
    ...overrides,
  }).id;
}

const land = (item: string): number => write({ item, fact: "landed", pinClass: "landed", pin: "c".repeat(40), step: "land" });

describe("collectMarkerBlobs", () => {
  it("GC keeps every blob of an open item, superseded rows included", () => {
    const first = write({ reads: [{ name: "conclusion", bytes: text("failure") }], output: large(0x61) });
    const second = write({ reads: [{ name: "conclusion", bytes: text("success") }], output: large(0x62) });

    const result = collectMarkerBlobs(db, store, { openItems: new Set([OPEN]), now: afterDays(400) });

    expect(result).toEqual({ kept: 4, deleted: 0, filesDeleted: 0 });
    expect(readMarkerValues(db, store, first).missing).toEqual([]);
    expect(readMarkerValues(db, store, second).missing).toEqual([]);
  });

  it("GC keeps the blobs an eval root names after the item closes and retention has passed", () => {
    const evaluated = write({ item: CLOSED, reads: [{ name: "conclusion", bytes: text("success") }], output: large(0x61) });
    land(CLOSED);
    db.prepare("INSERT INTO factory_marker_root (marker_id, kind, reason, added_at) VALUES (?, 'eval', 'synthetic eval', ?)").run(evaluated, LANDED_AT);

    const result = collectMarkerBlobs(db, store, { openItems: new Set(), now: afterDays(PAST_RETENTION) });

    expect(result).toMatchObject({ kept: 2, deleted: 0 });
    expect(readMarkerValues(db, store, evaluated).missing).toEqual([]);
  });

  it("GC deletes a closed item's blobs once retention passes, and its marker rows remain", () => {
    const id = write({ item: CLOSED, reads: [{ name: "conclusion", bytes: text("success") }], output: text("ok") });
    land(CLOSED);

    const inside = collectMarkerBlobs(db, store, { openItems: new Set(), now: afterDays(INSIDE_RETENTION) });
    const past = collectMarkerBlobs(db, store, { openItems: new Set(), now: afterDays(PAST_RETENTION) });

    expect(inside).toMatchObject({ kept: 2, deleted: 0 });
    expect(past).toMatchObject({ kept: 0, deleted: 2 });
    expect(count("factory_marker")).toBe(2);
    expect(readMarkerValues(db, store, id)).toEqual({ reads: new Map(), missing: ["conclusion", "output"] });
  });

  it("GC removes an out-of-line file whose blob row it deleted, and an orphan file with no row", () => {
    write({ item: CLOSED, reads: [], output: large(0x61) });
    land(CLOSED);
    const orphan = digestOf(large(0x7a)).slice("sha256:".length);
    writeFileSync(join(store.blobDir, orphan), large(0x7a));

    const result = collectMarkerBlobs(db, store, { openItems: new Set(), now: afterDays(PAST_RETENTION) });

    expect(result).toEqual({ kept: 0, deleted: 1, filesDeleted: 2 });
    expect(files()).toEqual([]);
  });

  it("GC never deletes a blob that a retained marker still references, even when an unretained one shares it", () => {
    const shared = large(0x73);
    write({ item: OPEN, reads: [{ name: "log", bytes: shared }] });
    write({ item: CLOSED, reads: [{ name: "log", bytes: shared }], output: text("closed-only") });
    land(CLOSED);

    const result = collectMarkerBlobs(db, store, { openItems: new Set([OPEN]), now: afterDays(PAST_RETENTION) });

    expect(result).toEqual({ kept: 1, deleted: 1, filesDeleted: 0 });
    expect(getBlob(db, store, digestOf(shared))).toEqual(shared);
    expect(getBlob(db, store, digestOf(text("closed-only")))).toBeUndefined();
  });

  it("GC collects a blob staged by a refused marker write", () => {
    write({ item: CLOSED, fact: "landed", pinClass: "landed", pin: "c".repeat(40), step: "land", reverted: true });
    expect(() => write({ item: CLOSED, reads: [{ name: "log", bytes: large(0x72) }] })).toThrow(/reverted item is terminal/);
    const unreferenced = putBlob(db, store, text("never-marked"), LANDED_AT);

    const result = collectMarkerBlobs(db, store, { openItems: new Set([CLOSED]), now: afterDays(1) });

    expect(result).toEqual({ kept: 0, deleted: 1, filesDeleted: 1 });
    expect(getBlob(db, store, unreferenced)).toBeUndefined();
    expect(files()).toEqual([]);
  });
});
