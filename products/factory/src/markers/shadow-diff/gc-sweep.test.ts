import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@titan-design/daemon";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { workflowMigration } from "@titan-design/workflow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBlob, type BlobStore } from "../blob-store.js";
import { DEFAULT_RETAIN_LANDED_DAYS } from "../gc.js";
import { writeMarker, type MarkerInput } from "../marker-store.js";
import { INLINE_LIMIT_BYTES, markerTableMigration } from "../marker-table.js";
import { openItemsOf, startMarkerGcSweep } from "./gc-sweep.js";

const LANDED_AT = "2026-11-01T12:00:00.000Z";
const PAST_RETENTION_MS = Date.parse(LANDED_AT) + (DEFAULT_RETAIN_LANDED_DAYS + 1) * 24 * 60 * 60 * 1000;

let dir: string;
let db: Db;
let store: BlobStore;
let runs = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marker-gc-sweep-"));
  db = openDatabase(join(dir, "factory.db"));
  runMigrations(db, [workflowMigration(1), markerTableMigration(2)]);
  store = { blobDir: join(dir, "marker-blobs"), capabilities: { refuse: () => undefined } };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function run(status: string, params: Record<string, string>): void {
  db.prepare("INSERT INTO workflow_run (id, workflow_name, params, status, started_at) VALUES (?, 'shepherd', ?, ?, ?)").run(`run-${++runs}`, JSON.stringify(params), status, LANDED_AT);
}

function mark(item: string, overrides: Partial<MarkerInput> = {}): void {
  writeMarker(db, store, { item, fact: "ci", pinClass: "tree", pin: "a".repeat(40), step: "check-ci", callSite: "land:1", version: "v1", inputDigests: {}, reads: [], writtenAt: LANDED_AT, ...overrides });
}

const land = (item: string): void => mark(item, { fact: "landed", pinClass: "landed", pin: "c".repeat(40), step: "land" });

describe("the marker GC sweep", () => {
  it("an item with a running workflow is open; a landed item is not", () => {
    run("running", { repo: "Owner/Open", pr: "1" });
    run("paused", { repo: "owner/paused", pr: "3" });
    run("completed", { repo: "owner/done", pr: "2" });
    run("running", { repo: "owner/landed", pr: "4" });
    run("running", { repo: "owner/audit" });
    land("owner/landed#4");

    expect(openItemsOf(db)).toEqual(new Set(["owner/open#1", "owner/paused#3"]));
  });

  it("the sweep collects an unreferenced blob of a closed item and keeps an open item's", async () => {
    const openBytes = Buffer.alloc(INLINE_LIMIT_BYTES + 1, 0x6f);
    const closedBytes = Buffer.alloc(INLINE_LIMIT_BYTES + 1, 0x63);
    run("running", { repo: "owner/name", pr: "1" });
    run("completed", { repo: "owner/name", pr: "2" });
    mark("owner/name#1", { output: openBytes });
    mark("owner/name#2", { output: closedBytes });
    land("owner/name#2");

    await startMarkerGcSweep(db, store, silentLogger, () => PAST_RETENTION_MS).stop();

    expect(getBlob(db, store, digestOf(openBytes))).toEqual(openBytes);
    expect(getBlob(db, store, digestOf(closedBytes))).toBeUndefined();
  });
});

const digestOf = (bytes: Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
