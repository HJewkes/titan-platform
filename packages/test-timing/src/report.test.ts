import type { Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TimingFile, TimingRun } from "./artifact.js";
import { timingArtifact, timingFile } from "./fixtures.test-helpers.js";
import { commitStartedMs } from "./queries.js";
import { slowerSince, timingReport } from "./report.js";
import { ingestArtifact, openTimingStore } from "./store.js";

// Synthetic suite: 3 projects of 20 files, each with a fixed base time, a seeded +-5% jitter per file and run, and a
// +-6% factor per run, the swing a hosted runner's suite total shows.
const PROJECTS = ["alpha", "beta", "gamma"];
const FILES = PROJECTS.flatMap((project) => Array.from({ length: 20 }, (_, index) => ({ project, file: `packages/${project}/src/f${index}.test.ts`, baseMs: 400 + 97 * index })));
const DAY = 86_400_000;
const START = Date.parse("2026-01-01T00:00:00.000Z");

function jitter(seed: number): number {
  const x = Math.sin(seed) * 10_000;
  return 0.95 + (x - Math.floor(x)) * 0.1;
}

function suiteRun(index: number, scale: (file: (typeof FILES)[number]) => number, run: Partial<TimingRun> = {}): void {
  const runner = 1 + (jitter(index * 7919) - 1) * 1.2;
  const files: TimingFile[] = FILES.map((entry, at) => {
    const testMs = Math.round(entry.baseMs * jitter(index * 131 + at) * runner * scale(entry));
    return timingFile({ project: entry.project, file: entry.file, collectMs: 0, setupMs: 0, testMs, totalMs: testMs });
  });
  const startedAt = new Date(START + index * (DAY / 4)).toISOString();
  ingestArtifact(db, timingArtifact({ id: `gha:${index}:1:1`, event: "push", pr: null, commit: index.toString(16).padStart(4, "0").repeat(10), startedAt, ...run }, files));
}

let db: Db;
beforeEach(() => {
  db = openTimingStore(":memory:");
});
afterEach(() => db.close());

describe("fork-cost regression replay", () => {
  // The shape of a regression where every test file paid about 15% more per run: no single file rose 25%, so only
  // the suite total against its rolling minimum shows it, and it must show by the second slow main run, within hours.
  const FORK_AT = 12;
  beforeEach(() => {
    for (let index = 0; index < FORK_AT; index += 1) suiteRun(index, () => 1);
    suiteRun(FORK_AT, () => 1.15);
    suiteRun(FORK_AT + 1, () => 1.15);
  });

  it("flags the second slow suite run as an anomaly and no run before it", () => {
    const report = timingReport(db, { recentRuns: 20 });

    expect(report.anomalies.map((verdict) => verdict.point.runId)).toEqual([`gha:${FORK_AT + 1}:1:1`]);
    expect(report.anomalies[0]?.heldRatio).toBeGreaterThan(0.12);
    expect(report.growth.filter((finding) => finding.level !== "suite")).toEqual([]);
  });

  it("raises no anomaly over the noisy runs alone", () => {
    db.prepare("DELETE FROM files WHERE run_id IN (?, ?)").run(`gha:${FORK_AT}:1:1`, `gha:${FORK_AT + 1}:1:1`);

    expect(timingReport(db, { recentRuns: 20 }).anomalies).toEqual([]);
  });

  it("names the suite and every project as slower since the regressing commit", () => {
    const cut = commitStartedMs(db, FORK_AT.toString(16).padStart(4, "0").repeat(3)) ?? 0;

    const slower = slowerSince(db, cut);

    expect(slower[0]).toMatchObject({ level: "suite", runnerClass: "gha-4c" });
    expect(slower.filter((finding) => finding.level === "project").map((finding) => finding.project).sort()).toEqual(PROJECTS);
  });
});

describe("timingReport growth", () => {
  it("flags one file that doubled for three runs and leaves its neighbours alone", () => {
    const slowFile = FILES[19]?.file;
    for (let index = 0; index < 10; index += 1) suiteRun(index, (entry) => (index >= 7 && entry.file === slowFile ? 2 : 1));

    const files = timingReport(db).growth.filter((finding) => finding.level === "file");

    expect(files.map((finding) => finding.file)).toEqual([slowFile]);
    expect(files[0]?.growth.since.runId).toBe("gha:7:1:1");
  });

  it("gives every project a trend once it has enough runs", () => {
    for (let index = 0; index < 6; index += 1) suiteRun(index, () => 1);

    const { projects } = timingReport(db);

    expect(projects.map((trend) => [trend.project, trend.runs])).toEqual(PROJECTS.map((project) => [project, 6]));
    expect(projects.every((trend) => trend.trend !== null && Math.abs(trend.trend.ratio) < 0.1)).toBe(true);
  });
});

describe("timingReport run selection", () => {
  it("leaves out scoped runs and a sharded run that lacks a shard", () => {
    for (let index = 0; index < 4; index += 1) suiteRun(index, () => 1);
    suiteRun(4, () => 0.2, { scope: { mode: "scoped", filters: [] } });
    suiteRun(5, () => 0.5, { id: "gha:5:1:1", shard: "1/2" });

    const [suite] = timingReport(db).suites;

    expect(suite?.verdicts.map((verdict) => verdict.point.runId)).toEqual(["gha:0:1:1", "gha:1:1:1", "gha:2:1:1", "gha:3:1:1"]);
  });

  it("sums the shards of one run into a single suite point", () => {
    suiteRun(0, () => 1, { id: "gha:9:1:1", shard: "1/2" });
    suiteRun(0, () => 1, { id: "gha:9:1:2", shard: "2/2" });

    const [suite] = timingReport(db).suites;

    expect(suite?.verdicts.map((verdict) => verdict.point.runId)).toEqual(["gha:9:1"]);
  });
});
