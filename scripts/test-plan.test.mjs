import { describe, expect, it } from "vitest";
import { fileCosts, judgeShards, judgeTable, mergeResults, packBins, planShards, SHARD_CAPS, shardSummaries } from "./test-plan.mjs";

const file = (path, project = "threads") => ({ path, project });
const durations = (entries) => new Map(Object.entries(entries));
// Synthetic suite: one slow file, two mid files, many fast ones; 1,600 s of tests in all.
const suite = [file("a/slow.test.ts"), file("b/mid.test.ts"), file("c/mid.test.ts", "repo"), ...Array.from({ length: 40 }, (_, i) => file(`d/f${i}.test.ts`))];
const suiteDurations = durations({
  "threads:a/slow.test.ts": 600_000,
  "threads:b/mid.test.ts": 300_000,
  "repo:c/mid.test.ts": 300_000,
  ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`threads:d/f${i}.test.ts`, 10_000])),
});

describe("fileCosts", () => {
  it("charges a file main never ran the median duration of the files it did", () => {
    const costs = fileCosts([file("x/new.test.ts")], durations({ "threads:a": 1_000, "threads:b": 3_000, "threads:c": 9_000 }));

    expect(costs).toEqual([{ path: "x/new.test.ts", project: "threads", known: false, seconds: 3.8 }]);
  });

  it("keys a file's duration by its project, so the same path in another project is unknown", () => {
    const [threads, repo] = fileCosts([file("a.test.ts"), file("a.test.ts", "repo")], durations({ "threads:a.test.ts": 2_000 }));

    expect([threads.known, repo.known]).toEqual([true, false]);
  });
});

describe("packBins", () => {
  it("packs the longest file first and balances the rest around it", () => {
    const costs = [5, 4, 3, 3, 3].map((seconds, i) => ({ path: `f${i}`, seconds }));

    const bins = packBins(costs, 2).map((bin) => bin.files.map((f) => f.seconds));

    expect(bins).toEqual([[5, 3], [4, 3, 3]]);
  });

  it("estimates a bin by its longest file when that file outlasts the bin's share of the workers", () => {
    const [bin] = packBins([{ path: "big", seconds: 200 }, { path: "small", seconds: 8 }], 1);

    expect(bin.estimateSeconds).toBe(200);
  });
});

describe("planShards", () => {
  it("sizes the shard count from the estimate at about 300 s of wall per shard", () => {
    const shards = planShards(suite, suiteDurations, SHARD_CAPS.main);

    expect(shards.map((s) => `${s.index}/${s.total}`)).toEqual(["1/2", "2/2"]);
    expect(shards.flatMap((s) => s.files).sort((a, b) => a.path.localeCompare(b.path))).toEqual([...suite].sort((a, b) => a.path.localeCompare(b.path)));
  });

  it("never plans more shards than the cap", () => {
    const heavy = durations(Object.fromEntries(suite.map((f) => [`${f.project}:${f.path}`, 600_000])));

    expect(planShards(suite, heavy, SHARD_CAPS.pullRequest)).toHaveLength(4);
    expect(planShards(suite, heavy, SHARD_CAPS.main)).toHaveLength(6);
  });

  it("runs the full cap when main has no durations at all, rather than trusting an overhead-only estimate", () => {
    expect(planShards(suite, new Map(), SHARD_CAPS.pullRequest)).toHaveLength(4);
  });

  it("plans no shard for no files", () => {
    expect(planShards([], suiteDurations, SHARD_CAPS.main)).toEqual([]);
  });

  it("drops the file lists from the matrix summary and keeps each shard's size", () => {
    const [first] = shardSummaries(planShards(suite, suiteDurations, SHARD_CAPS.main));

    expect(Object.keys(first).sort()).toEqual(["estimateSeconds", "fileCount", "index", "total"]);
  });
});

describe("judgeShards", () => {
  const shards = [
    { index: 1, total: 2, estimateSeconds: 300, fileCount: 10 },
    { index: 2, total: 2, estimateSeconds: 280, fileCount: 12 },
  ];
  const job = (name, status, conclusion) => ({ name, status, conclusion, startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:05:10Z" });

  it("waits while a shard is still running or not yet listed", () => {
    expect(judgeShards(shards, [job("test (1/2)", "completed", "success"), job("test (2/2)", "in_progress", null)]).state).toBe("pending");
    expect(judgeShards(shards, [job("test (1/2)", "completed", "success")]).state).toBe("pending");
  });

  it("is red when any completed shard did not succeed", () => {
    const jobs = [job("test (1/2)", "completed", "success"), job("test (2/2)", "completed", "failure"), job("validate", "in_progress", null)];

    expect(judgeShards(shards, jobs).state).toBe("red");
  });

  it("is green once every shard succeeded, and tables each shard's estimate beside its job time", () => {
    const verdict = judgeShards(shards, [job("test (1/2)", "completed", "success"), job("test (2/2)", "completed", "success")]);

    expect(verdict.state).toBe("green");
    expect(judgeTable(verdict.rows)).toContain("| test (1/2) | 10 | 300 | 310 | success |");
  });

  it("is green with nothing to wait for when no shard was planned", () => {
    expect(judgeShards([], [job("validate", "in_progress", null)]).state).toBe("green");
  });
});

describe("mergeResults", () => {
  it("keeps main's durations for planned files, takes fresh ones over them, and drops files no longer planned", () => {
    const previous = [["threads:a", { duration: 1 }], ["threads:gone", { duration: 2 }], ["threads:b", { duration: 3 }]];
    const measured = [["threads:a", { duration: 10 }], ["threads:stray", { duration: 4 }]];

    const merged = mergeResults(previous, measured, [file("a"), file("b")]);

    expect(Object.fromEntries(merged)).toEqual({ "threads:a": { duration: 10 }, "threads:b": { duration: 3 } });
  });
});
