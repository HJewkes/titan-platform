import type { Db } from "@titan-design/store-sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { timingArtifact, timingFile } from "./fixtures.test-helpers.js";
import { ghRunFetched, ingestGhArtifact, ingestRecord, ingestSpool, markGhRunFetched, parseArtifactName } from "./ingest.js";
import type { GhRunMeta } from "./legacy.js";
import { openTimingStore } from "./store.js";

const META: GhRunMeta = { databaseId: 5001, attempt: 2, headSha: "e".repeat(40), headBranch: "main", event: "push", createdAt: "2026-02-03T04:05:06Z", repo: "example/repo" };
const legacy = { files: [{ project: "unit", file: "packages/example/src/a.test.ts", state: "passed", environmentMs: 0, prepareMs: 1, collectMs: 100, setupMs: 10, testMs: 400 }] };

let db: Db;
let home: string;
beforeEach(() => {
  db = openTimingStore(":memory:");
  home = mkdtempSync(path.join(tmpdir(), "test-timing-home-"));
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("ingestRecord", () => {
  it("archives the record gzipped with its checksum in the month's SHA256SUMS and on the run row", () => {
    ingestRecord(db, home, timingArtifact());

    const dir = path.join(home, "raw/gha/2026-01");
    const gz = readFileSync(path.join(dir, "gha_1001_1_1.json.gz"));
    const sha = createHash("sha256").update(gz).digest("hex");
    expect(JSON.parse(gunzipSync(gz).toString()).run.id).toBe("gha:1001:1:1");
    expect(readFileSync(path.join(dir, "SHA256SUMS"), "utf8")).toBe(`${sha}  gha_1001_1_1.json.gz\n`);
    expect(db.prepare("SELECT raw_path, raw_sha256 FROM runs").get()).toEqual({ raw_path: "raw/gha/2026-01/gha_1001_1_1.json.gz", raw_sha256: sha });
  });

  it("writes no second checksum line when a run is ingested again", () => {
    ingestRecord(db, home, timingArtifact());

    const again = ingestRecord(db, home, timingArtifact());

    expect(again.inserted).toBe(false);
    expect(readFileSync(path.join(home, "raw/gha/2026-01/SHA256SUMS"), "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe("parseArtifactName", () => {
  it("reads the attempt and the shard from a CI artifact name", () => {
    expect(parseArtifactName("vitest-file-timing-3")).toEqual({ attempt: 3, shard: null });
    expect(parseArtifactName("vitest-file-timing-shard2of3-1")).toEqual({ attempt: 1, shard: "2/3" });
    expect(parseArtifactName("codewatch-report")).toBeNull();
  });
});

describe("ingestGhArtifact", () => {
  it("gives a pre-header record a header from the run metadata and the artifact's own attempt and shard", () => {
    ingestGhArtifact(db, home, "vitest-file-timing-shard2of3-1", legacy, META);

    const run = db.prepare("SELECT id, commit_sha, event, scope, shard, runner_class, started_at FROM runs").get();
    expect(run).toEqual({ id: "gha:5001:1:2", commit_sha: "e".repeat(40), event: "push", scope: "full", shard: "2/3", runner_class: "gha-4c", started_at: "2026-02-03T04:05:06.000Z" });
    expect(db.prepare("SELECT total_ms, tests FROM files").get()).toEqual({ total_ms: 510, tests: 0 });
  });

  it("tags a pre-header pull request record as scoped, since a pull request may not run the full suite", () => {
    ingestGhArtifact(db, home, "vitest-file-timing-1", legacy, { ...META, event: "pull_request" });

    expect(db.prepare("SELECT event, scope FROM runs").get()).toEqual({ event: "pull_request", scope: "scoped" });
  });

  it("stores a v1 record under its own header and dedupes it on run id", () => {
    ingestGhArtifact(db, home, "vitest-file-timing-1", timingArtifact(), META);
    const again = ingestGhArtifact(db, home, "vitest-file-timing-1", timingArtifact(), META);

    expect(again.inserted).toBe(false);
    expect(db.prepare("SELECT id, pr FROM runs").all()).toEqual([{ id: "gha:1001:1:1", pr: 7 }]);
  });
});

describe("gh run fetch marks", () => {
  it("records a run attempt as fetched, even one with no artifacts, and keeps attempts apart", () => {
    // Mutant caught: skipping the mark, which makes every scheduled pass download the run again.
    markGhRunFetched(db, 5001, 1, 0);

    expect(ghRunFetched(db, 5001, 1)).toBe(true);
    expect(ghRunFetched(db, 5001, 2)).toBe(false);
  });
});

describe("ingestSpool", () => {
  const spool = () => path.join(home, "spool");
  const NOW = Date.parse("2026-01-01T01:00:00.000Z");

  function spoolFile(name: string, body: string, ageMs = 120_000) {
    mkdirSync(spool(), { recursive: true });
    const file = path.join(spool(), name);
    writeFileSync(file, body);
    const at = new Date(NOW - ageMs);
    utimesSync(file, at, at);
  }

  it("moves a settled record into the archive and a malformed one to rejected with a reason", () => {
    spoolFile("good.json", JSON.stringify(timingArtifact({ id: "verify-changed:host-a:t:1", runner: "verify-changed", event: "local" })));
    spoolFile("bad.json", JSON.stringify(timingArtifact({}, [{ ...timingFile(), tests: -1 }])));

    const result = ingestSpool(db, home, { now: NOW });

    expect(result).toMatchObject({ ingested: 1, duplicates: 0, waiting: 0 });
    expect(result.rejected.map((entry) => entry.file)).toEqual(["bad.json"]);
    expect(readdirSync(spool())).toEqual(["rejected"]);
    expect(readFileSync(path.join(spool(), "rejected/bad.json.reason"), "utf8")).not.toBe("");
    expect(existsSync(path.join(home, "raw/verify-changed/2026-01/verify-changed_host-a_t_1.json.gz"))).toBe(true);
  });

  it("leaves a record the reporter may still be writing for the next pass", () => {
    spoolFile("fresh.json", "{", 1_000);

    const result = ingestSpool(db, home, { now: NOW });

    expect(result).toEqual({ ingested: 0, duplicates: 0, waiting: 1, rejected: [] });
    expect(readdirSync(spool())).toEqual(["fresh.json"]);
  });

  it("returns an empty result when no spool exists yet", () => {
    expect(ingestSpool(db, home, { now: NOW })).toEqual({ ingested: 0, duplicates: 0, waiting: 0, rejected: [] });
  });
});
