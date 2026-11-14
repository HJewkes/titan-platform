import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Track } from "../arms.js";
import { JOB_SCHEMA, type Outcome } from "../ledger.js";
import { buildReport, writeReport } from "./report.js";
import { TOO_THIN } from "./routing.js";
import { holm } from "./stats.js";

const MODELS: Record<string, string> = { O: "claude-opus-5-5", S: "claude-sonnet-5-5", H: "claude-haiku-5-5", F: "claude-fable-5-2" };

interface JobSpec {
  arm: string;
  block: number;
  result: Record<string, unknown>;
  stratum?: Record<string, string>;
  outcome?: Outcome;
  listUsd?: number;
  pilotOnly?: boolean;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bench-report-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeRun(name: string, track: Track, jobs: readonly JobSpec[], judgments: readonly unknown[] = []): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const jobRows = jobs.map((job) => {
    const [family = "O", effort = "med"] = job.arm.split("-");
    const arm = { id: job.arm, model: MODELS[family] ?? "claude-opus-5-5", effort: effort === "med" ? "medium" : effort, ...(job.pilotOnly === true && { pilotOnly: true }) };
    const caseId = `case-${job.block}`;
    const common = { track, caseId, caseHash: `hash-${job.block}`, attempt: 1 };
    const row = { schema: JOB_SCHEMA, ...common, arm, block: job.block, stratum: job.stratum ?? { kind: "feature" }, sessionId: `${job.arm}-${job.block}`, transcript: "/srv/x/t.jsonl" };
    const times = { startedAt: "2026-11-01T00:00:00Z", endedAt: "2026-11-01T00:01:00Z", seconds: 60, exit: { code: 0, timedOut: false } };
    const usage = { tokens: { [arm.model]: { input: 1, output: 2, cacheRead: 3, cacheWrite5m: 0, cacheWrite1h: 4 } }, listUsd: job.listUsd ?? 0.1, effortSeen: [arm.effort], modelSeen: [arm.model] };
    return { jobRow: { ...row, ...times, outcome: job.outcome ?? "ok", ...usage }, scoreRow: { schema: "titan.bench-score/v1", ...common, arm: job.arm, outcome: job.outcome ?? "ok", result: job.result } };
  });
  const lines = (rows: readonly unknown[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  writeFileSync(join(dir, "jobs.jsonl"), lines(jobRows.map((entry) => entry.jobRow)));
  writeFileSync(join(dir, "scores.jsonl"), lines(jobRows.map((entry) => entry.scoreRow)));
  writeFileSync(join(dir, "judgments.jsonl"), lines(judgments));
  return dir;
}

const planted = (caught: boolean) => ({ caseType: "planted", verdict: caught ? "FIX_FIRST" : "MERGE", contract: false, caught, caughtPath: caught, caughtVerdict: caught, falseAlarm: null });
const clean = (falseAlarm: boolean) => ({ caseType: "clean", verdict: falseAlarm ? "FIX_FIRST" : "MERGE", contract: false, caught: null, caughtPath: null, caughtVerdict: null, falseAlarm });
const implement = (solved: boolean) => ({ hiddenPass: solved, ownPass: solved, typecheck: true, solved, diffLogRatio: 0.5 });

function reviewBlocks(blocks: number, arms: readonly string[], caught: (arm: string, block: number) => boolean): JobSpec[] {
  return Array.from({ length: blocks }, (_, block) => arms.map((arm) => ({ arm, block, stratum: { kind: "feature", caseType: "planted" }, result: planted(caught(arm, block)) }))).flat();
}

const reviewPick = (report: ReturnType<typeof buildReport>, kind: string) => report.routing.find((row) => row.kind === kind && row.size === "any")?.review;

describe("routing thinness", () => {
  it("keeps production in a cell with fewer than 8 complete blocks, even when every arm agrees", () => {
    const run = writeRun("r7", "r", reviewBlocks(7, ["O-med", "S-med"], () => true));

    const report = buildReport({ runs: { r: run }, partial: false, targets: {} });

    expect(reviewPick(report, "feature")).toMatchObject({ text: TOO_THIN, pick: null, n: 7 });
  });

  it("picks the cheaper arm once the cell reaches 8 complete blocks with a tight CI", () => {
    const jobs = reviewBlocks(8, ["O-med", "S-med"], () => true).map((job) => ({ ...job, listUsd: job.arm === "S-med" ? 0.01 : 0.3 }));
    const run = writeRun("r8", "r", jobs);

    const report = buildReport({ runs: { r: run }, partial: false, targets: {} });

    expect(reviewPick(report, "feature")).toMatchObject({ text: "S-med", pick: "S-med", n: 8 });
  });
});

describe("complete blocks only", () => {
  it("leaves a block missing an arm out of the paired tables and lists it", () => {
    const jobs = reviewBlocks(4, ["O-med", "S-med"], (arm, block) => arm === "O-med" || block < 3).filter((job) => !(job.arm === "S-med" && job.block === 3));

    const report = buildReport({ runs: { r: writeRun("inc", "r", jobs) }, partial: false, targets: {} });

    const track = report.tracks.r;
    const plantedTable = track?.tables.find((view) => view.id === "planted");
    expect(track?.blocks.complete).toHaveLength(3);
    expect(track?.blocks.incomplete).toEqual([{ caseId: "case-3", block: 3, missing: [{ arm: "S-med", outcome: "no job" }] }]);
    expect(plantedTable?.rows.find((row) => row.arm === "O-med")?.primary).toMatchObject({ successes: 3, n: 3 });
  });

  it("drops a contaminated job's block from the paired tables and lists the job", () => {
    const jobs: JobSpec[] = [0, 1, 2].flatMap((block) =>
      ["O-med", "S-high"].map((arm) => ({ arm, block, stratum: { kind: "feature", size: "S" }, result: implement(true), ...(arm === "S-high" && block === 1 && { outcome: "contaminated" as const, result: implement(true) }) })),
    );

    const report = buildReport({ runs: { i: writeRun("cont", "i", jobs) }, partial: false, targets: {} });

    const track = report.tracks.i;
    expect(track?.blocks.complete).toEqual(["hash-0", "hash-2"]);
    expect(track?.blocks.excluded).toEqual([{ arm: "S-high", caseId: "case-1", block: 1, outcome: "contaminated" }]);
    expect(track?.tables[0]?.rows.map((row) => row.n)).toEqual([2, 2]);
    expect(track?.extra.perArm).toMatchObject({ "S-high": { contaminated: 1 } });
  });

  it("compares a pilot-only arm with production on the blocks they share and prints that n", () => {
    const core = [0, 1, 2, 3, 4].flatMap((block) => ["O-med", "S-high"].map((arm) => ({ arm, block, stratum: { kind: "feature", size: "S" }, result: implement(block !== 4) })));
    const pilot = [0, 1].map((block) => ({ arm: "F-high", block, pilotOnly: true, stratum: { kind: "feature", size: "S" }, result: implement(false) }));

    const report = buildReport({ runs: { i: writeRun("pilot", "i", [...core, ...pilot]) }, partial: false, targets: {} });

    const track = report.tracks.i;
    expect(track?.blocks.sideArms).toEqual(["F-high"]);
    expect(track?.blocks.complete).toHaveLength(5);
    const view = track?.tables[0];
    expect(view?.rows.find((row) => row.arm === "F-high")).toMatchObject({ side: true, n: 2 });
    expect(view?.comparisons.find((entry) => entry.arm === "F-high")?.diff).toMatchObject({ n: 2, delta: -1, productionAhead: 2 });
  });
});

describe("Holm correction", () => {
  it("adjusts a known p-value set step-down and keeps the input order", () => {
    const adjusted = holm([0.01, 0.04, 0.03, 0.005]);

    expect(adjusted.map((p) => Number(p.toFixed(6)))).toEqual([0.03, 0.06, 0.06, 0.02]);
  });
});

describe("report files", () => {
  it("writes a PARTIAL skeleton with coordinator placeholders when a track is below its target", () => {
    const run = writeRun("files", "r", reviewBlocks(3, ["O-med", "S-med"], () => true));
    const out = join(root, "out");

    writeReport({ runs: { r: run }, partial: false, targets: { r: 160 } }, out);

    const markdown = readFileSync(join(out, "REPORT.md"), "utf8");
    expect(markdown).toContain("**PARTIAL.** Complete blocks per track: R 3 of 160");
    expect(markdown).toContain("<!-- coordinator: routing recommendations -->");
    expect(markdown).toContain(TOO_THIN);
    expect(JSON.parse(readFileSync(join(out, "report.json"), "utf8"))).toMatchObject({ partial: true, completeBlocks: { r: 3 } });
  });

  it("prints the same report twice from the same ledgers", () => {
    const run = writeRun("seed", "r", reviewBlocks(9, ["O-med", "S-med"], (arm, block) => arm === "O-med" || block % 2 === 0));

    const first = JSON.stringify(buildReport({ runs: { r: run }, partial: false, targets: {} }));

    expect(JSON.stringify(buildReport({ runs: { r: run }, partial: false, targets: {} }))).toBe(first);
  });
});

const JUDGMENT = { schema: "titan.bench-judgment/v1", kind: "item", batchId: "b1", judge: { model: "claude-sonnet-5-5", effort: "high" } };

describe("judged metrics", () => {
  it("drops a false alarm from the judge-adjusted rate once the judge calls its finding real", () => {
    const jobs = [0, 1].flatMap((block) => ["O-med", "S-med"].map((arm) => ({ arm, block, stratum: { kind: "feature", caseType: "clean" }, result: clean(arm === "S-med") })));
    const run = writeRun("fa", "r", jobs, [{ ...JUDGMENT, track: "r-fa", key: "S-med:case-0:0", outcome: "real" }]);

    const report = buildReport({ runs: { r: run }, partial: false, targets: {} });

    const row = report.tracks.r?.tables.find((view) => view.id === "clean")?.rows.find((entry) => entry.arm === "S-med");
    expect(row?.primary).toMatchObject({ successes: 2, n: 2 });
    expect(row?.secondary.judgeAdjusted).toMatchObject({ successes: 1, n: 2 });
  });

  it("reads P win rate from pairwise outcomes against the anchor, ties apart", () => {
    const jobs = [0, 1, 2].flatMap((block) => ["O-med", "S-high"].map((arm) => ({ arm, block, stratum: { pool: "multi", kind: "feature" }, result: { parse: "ok", sliceError: -1, fileRecall: 0.5, pool: "multi" } })));
    const outcomes = ["A", "tie", "B"].map((outcome, block) => ({ ...JUDGMENT, track: "p", key: `p:case-${block}:S-high~O-med`, outcome }));

    const report = buildReport({ runs: { p: writeRun("plan", "p", jobs, outcomes) }, partial: false, targets: {} });

    const track = report.tracks.p;
    expect(track?.tables[0]?.rows.find((row) => row.arm === "S-high")?.primary).toMatchObject({ successes: 1, n: 2 });
    expect(track?.tables[0]?.comparisons[0]?.diff).toMatchObject({ n: 3, delta: 0, armAhead: 1, productionAhead: 1 });
    expect(track?.extra.perArm).toMatchObject({ "S-high": { wins: 1, ties: 1, losses: 1, judges: ["claude-sonnet-5-5/high"] } });
  });
});
