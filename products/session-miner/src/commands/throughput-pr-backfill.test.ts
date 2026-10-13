import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeGitHub, fakeSha, type FakeGitHub, type PrFile } from "@titan-design/github";
import { openSessionGraph } from "@titan-design/session-graph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runCli } from "../cli.js";
import { backfillPrDiffs, prDiffCachePath, readPrDiffCache, type BackfillDeps } from "./throughput-pr-backfill.js";

let dir: string;
let cachePath: string;
let github: FakeGitHub;

const REFS = ["pr:o/r#1", "pr:o/r#2", "pr:o/r#3"];

function mergedPr(files: PrFile[], changedFiles = files.length): number {
  const pr = github.addPr({ headSha: fakeSha(`head${files.length}`), merged: true, state: "closed" });
  github.prFiles.set(pr.number, files);
  github.prChangedFiles.set(pr.number, changedFiles);
  return pr.number;
}

const file = (p: string, additions = 10, deletions = 2): PrFile => ({ path: p, status: "modified", additions, deletions });
const deps = (overrides: Partial<BackfillDeps> = {}): BackfillDeps => ({ wire: github.wire, budget: { remaining: null }, ...overrides });
const fetches = (): number => github.calls.filter((c) => c === "getPr" || c === "listPrFiles").length;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-pr-backfill-"));
  cachePath = path.join(dir, "state", "pr-diffs.json");
  github = fakeGitHub();
  for (const n of [1, 2, 3]) mergedPr([file(`src/f${n}.ts`)]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("backfillPrDiffs", () => {
  it("fetches only uncached refs, and a second run makes no call", async () => {
    await backfillPrDiffs(REFS.slice(0, 1), cachePath, deps());
    github.calls.length = 0;

    const first = await backfillPrDiffs(REFS, cachePath, deps());
    const callsFirst = github.calls.filter((c) => c === "getPr").length;
    const filesFirst = github.calls.filter((c) => c === "listPrFiles").length;
    github.calls.length = 0;
    const second = await backfillPrDiffs(REFS, cachePath, deps());

    expect([callsFirst, filesFirst]).toEqual([2, 2]);
    expect(first).toMatchObject({ alreadyCached: 1, fetched: 2, remaining: 0 });
    expect(github.calls).toEqual([]);
    expect(second).toMatchObject({ alreadyCached: 3, fetched: 0 });
  });

  it("writes the cache readable only by its owner", async () => {
    await backfillPrDiffs(REFS, cachePath, deps());

    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
  });

  it("caches head sha and per-file counts that readPrDiffCache returns by ref", async () => {
    await backfillPrDiffs(REFS, cachePath, deps());

    const diff = readPrDiffCache(cachePath).get("pr:o/r#2");
    expect(diff).toEqual({ prRef: "pr:o/r#2", repo: "o/r", pr: 2, head: github.pr(2).headSha, files: [{ path: "src/f2.ts", additions: 10, deletions: 2 }], truncated: false });
  });

  it("stops at the rate floor with the fetched PR saved and the rest reported", async () => {
    const budget = { remaining: 600 as number | null };
    const getPr: BackfillDeps["getPr"] = async (repo, n) => {
      budget.remaining = 500;
      return github.wire.getPr(repo, n);
    };

    const result = await backfillPrDiffs(REFS, cachePath, deps({ budget, getPr, concurrency: 1 }));

    expect(result).toMatchObject({ fetched: 1, remaining: 2, stoppedAtFloor: true, rateRemaining: 500 });
    expect([...readPrDiffCache(cachePath).keys()]).toEqual(["pr:o/r#1"]);
  });

  it("marks a PR past GitHub's file cap as truncated", async () => {
    const big = mergedPr(Array.from({ length: 3000 }, (_, i) => file(`gen/${i}.ts`, 1, 0)), 3500);

    await backfillPrDiffs([`pr:o/r#${big}`], cachePath, deps());

    expect(readPrDiffCache(cachePath).get(`pr:o/r#${big}`)?.truncated).toBe(true);
  });

  it("caches a 404 as missing, so it is never retried and never read as a diff", async () => {
    const first = await backfillPrDiffs(["pr:o/r#99"], cachePath, deps());
    github.calls.length = 0;
    await backfillPrDiffs(["pr:o/r#99"], cachePath, deps());

    expect(first).toMatchObject({ fetched: 0, missing: 1 });
    expect(fetches()).toBe(0);
    expect(readPrDiffCache(cachePath).has("pr:o/r#99")).toBe(false);
  });

  it("fetches at most limit uncached PRs and counts the rest as remaining", async () => {
    const result = await backfillPrDiffs(REFS, cachePath, deps({ limit: 2 }));

    expect(result).toMatchObject({ fetched: 2, remaining: 1 });
  });
});

describe("readPrDiffCache", () => {
  it("returns an empty map when no backfill has run", () => {
    expect(readPrDiffCache(cachePath).size).toBe(0);
  });

  it("refuses a cache file that does not match the schema", () => {
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ v: 1, prs: { "pr:o/r#1": { prRef: "pr:o/r#1" } } }));

    expect(() => readPrDiffCache(bad)).toThrow(/invalid PR diff cache/);
  });
});

describe("titan-miner throughput pr-backfill --dry-run", () => {
  it("counts uncached merged PRs per repo without calling GitHub", async () => {
    const graphFile = path.join(dir, "graph.sqlite3");
    const graph = openSessionGraph(graphFile);
    const insert = graph.db.prepare("INSERT INTO pr (pr_ref, merged_at) VALUES (?, ?)");
    for (const [ref, mergedAt] of [["pr:o/r#1", "2026-09-01T00:00:00Z"], ["pr:o/r#2", null], ["pr:me/notes#4", "2026-09-02T00:00:00Z"]] as const) insert.run(ref, mergedAt);
    graph.db.close();
    let stdout = "";
    const io = { stdout: (t: string) => void (stdout += t), stderr: () => undefined, env: {} };

    const code = await runCli(["--state", path.join(dir, "state"), "--graph", graphFile, "--json", "throughput", "pr-backfill", "--dry-run"], io);

    expect(code).toBe(0);
    const data = z.object({ data: z.object({ refs: z.number(), alreadyCached: z.number(), cachePath: z.string(), toFetchByRepo: z.record(z.string(), z.number()) }) }).parse(JSON.parse(stdout)).data;
    expect(data).toEqual({ refs: 2, alreadyCached: 0, cachePath: prDiffCachePath(path.join(dir, "state")), toFetchByRepo: { "me/notes": 1, "o/r": 1 } });
  });
});
