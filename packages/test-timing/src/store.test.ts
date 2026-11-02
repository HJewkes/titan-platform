import { hasTable, type Db } from "@titan-design/store-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { timingArtifact, timingFile } from "./fixtures.test-helpers.js";
import { ingestArtifact, openTimingStore, storeStats } from "./store.js";

const count = (db: Db, table: "runs" | "files") => db.prepare<[], number>(`SELECT COUNT(*) FROM ${table}`).pluck().get();

let db: Db;
beforeEach(() => {
  db = openTimingStore(":memory:");
});
afterEach(() => db.close());

describe("ingestArtifact", () => {
  it("stores one run row and a row per file", () => {
    const result = ingestArtifact(db, timingArtifact(), { path: "raw/gha/2026-01/gha_1001_1_1.json.gz", sha256: "d".repeat(64) });

    expect(result).toEqual({ runId: "gha:1001:1:1", inserted: true, files: 2 });
    const run = db.prepare("SELECT commit_sha, scope, raw_sha256, load_mean FROM runs").get();
    expect(run).toEqual({ commit_sha: "a".repeat(40), scope: "full", raw_sha256: "d".repeat(64), load_mean: 1.5 });
    expect(count(db, "files")).toBe(2);
  });

  it("is a no-op when the same run is ingested twice", () => {
    // Mutant caught: dropping the run.id uniqueness check, which would store the run and its files again.
    ingestArtifact(db, timingArtifact());

    const again = ingestArtifact(db, timingArtifact());

    expect(again).toEqual({ runId: "gha:1001:1:1", inserted: false, files: 0 });
    expect(count(db, "runs")).toBe(1);
    expect(count(db, "files")).toBe(2);
  });

  it("stores nothing from an artifact that fails to parse", () => {
    const broken = timingArtifact({}, [timingFile(), { ...timingFile(), tests: -1 }]);

    expect(() => ingestArtifact(db, broken)).toThrow();
    expect(count(db, "runs")).toBe(0);
  });

  it("separates a 4-vCPU CI runner from a 48-core local host by runner class", () => {
    ingestArtifact(db, timingArtifact());
    ingestArtifact(db, timingArtifact({ id: "basement-suite:host-b:2026-01-01T00:00:00.000Z:42", runner: "basement-suite", host: "host-b", cpus: 48 }));

    const classes = db.prepare("SELECT DISTINCT runner_class FROM files ORDER BY runner_class").pluck().all();

    expect(classes).toEqual(["basement-suite-48c", "gha-4c"]);
  });

  it("keeps each local run's host so dev machines stay apart", () => {
    ingestArtifact(db, timingArtifact({ id: "dev:mac-a:t:1", runner: "dev", host: "mac-a", cpus: 12 }));
    ingestArtifact(db, timingArtifact({ id: "dev:mac-b:t:2", runner: "dev", host: "mac-b", cpus: 12 }));

    const hosts = db.prepare("SELECT host FROM runs WHERE runner_class = 'dev-12c' ORDER BY host").pluck().all();

    expect(hosts).toEqual(["mac-a", "mac-b"]);
  });
});

describe("openTimingStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "test-timing-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("installs the ingest watermark and opens read-only without migrating", () => {
    const file = path.join(dir, "timing.db");
    openTimingStore(file).close();

    const reader = openTimingStore(file, { readonly: true });

    expect(hasTable(reader, "watermark")).toBe(true);
    expect(() => reader.prepare("DELETE FROM runs").run()).toThrow(/readonly/);
    reader.close();
  });
});

describe("storeStats", () => {
  it("counts runs and files and spans their start times", () => {
    ingestArtifact(db, timingArtifact());
    ingestArtifact(db, timingArtifact({ id: "gha:1002:1:1", startedAt: "2026-01-02T00:00:00.000Z" }));

    const stats = storeStats(db);

    expect(stats).toMatchObject({ runs: 2, files: 4, oldestStartedAt: "2026-01-01T00:00:00.000Z", newestStartedAt: "2026-01-02T00:00:00.000Z" });
    expect(stats.bytes).toBeGreaterThan(0);
  });
});
