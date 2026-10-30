import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as timing from "../packages/test-timing/dist/index.js";
import { ingestGh, parseArgs } from "./test-timing.mjs";

// Synthetic runs only: example repo, shas and run ids.
const RUNS = [
  { databaseId: 9002, attempt: 1, headSha: "b".repeat(40), headBranch: "feat/x", event: "pull_request", createdAt: "2026-01-02T00:00:00Z" },
  { databaseId: 9001, attempt: 2, headSha: "a".repeat(40), headBranch: "main", event: "push", createdAt: "2026-01-01T00:00:00Z" },
];
const legacy = { files: [{ project: "unit", file: "packages/example/src/a.test.ts", state: "passed", environmentMs: 0, prepareMs: 1, collectMs: 100, setupMs: 10, testMs: 400 }] };

function stubGh({ artifacts, failing = new Set() }) {
  const calls = [];
  const gh = (args) => {
    calls.push(args.slice(0, 3).join(" "));
    if (args[1] === "list") return JSON.stringify(RUNS);
    const id = Number(args[2]);
    if (failing.has(id)) throw Object.assign(new Error("HTTP 502"), { stderr: "HTTP 502" });
    const names = artifacts[id] ?? [];
    if (names.length === 0) throw Object.assign(new Error("exit 1"), { stderr: "no artifact matches any of the names or patterns provided\n" });
    const dir = args[args.indexOf("--dir") + 1];
    for (const name of names) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "vitest-file-timing.json"), JSON.stringify(legacy));
    }
    return "";
  };
  return { gh, calls };
}

let root;
let db;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "test-timing-cli-"));
  mkdirSync(join(root, "scratch"));
  db = timing.openTimingStore(":memory:");
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const pass = (gh) => ingestGh(timing, db, { gh, home: join(root, "home"), scratch: join(root, "scratch"), repo: "example/repo", workflow: "ci.yml", limit: 10 });

describe("test-timing ingest-gh", () => {
  it("stores every shard and attempt of a main run and leaves a none-scope pull request run with no rows", () => {
    const { gh } = stubGh({ artifacts: { 9001: ["vitest-file-timing-shard1of3-1", "vitest-file-timing-shard2of3-1", "vitest-file-timing-shard1of3-2"] } });

    const summary = pass(gh);

    expect(summary).toEqual({ runs: 2, skipped: 0, artifacts: 3, inserted: 3, failed: [] });
    expect(db.prepare("SELECT id FROM runs ORDER BY id").pluck().all()).toEqual(["gha:9001:1:1", "gha:9001:1:2", "gha:9001:2:1"]);
  });

  it("downloads nothing again on a second pass over the same runs", () => {
    const { gh, calls } = stubGh({ artifacts: { 9001: ["vitest-file-timing-shard1of3-2"] } });
    pass(gh);
    calls.length = 0;

    const summary = pass(gh);

    expect(summary).toMatchObject({ runs: 0, skipped: 2, inserted: 0 });
    expect(calls).toEqual(["run list --repo"]);
  });

  it("reports a failed download and retries it on the next pass", () => {
    const failing = new Set([9002]);
    const { gh } = stubGh({ artifacts: { 9002: ["vitest-file-timing-1"] }, failing });

    expect(pass(gh).failed).toEqual([{ run: 9002, reason: "HTTP 502" }]);
    failing.clear();

    expect(pass(gh)).toMatchObject({ runs: 1, skipped: 1, inserted: 1 });
    expect(db.prepare("SELECT event, scope FROM runs").get()).toEqual({ event: "pull_request", scope: "scoped" });
  });
});

describe("test-timing arguments", () => {
  it("keeps the corpus under TITAN_TEST_TIMING_HOME", () => {
    const options = parseArgs(["ingest-spool"], { TITAN_TEST_TIMING_HOME: "/data/timing" });

    expect(options).toMatchObject({ command: "ingest-spool", home: "/data/timing", db: "/data/timing/timing.db" });
  });
});
