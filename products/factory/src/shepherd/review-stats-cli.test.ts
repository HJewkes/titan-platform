import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@titan-design/store-sqlite";
import { WorkflowRunStore, type WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { openFactoryHost } from "../host.js";
import { factoryRoutes, factoryWorkflows } from "../workflows.js";
import { REVIEW_STATS_DB } from "./review-stats-store.js";

const MIN = 60_000;
const DAY1 = Date.parse("2026-10-05T10:00:00Z");
const DAY2 = Date.parse("2026-10-06T10:00:00Z");

/** One review round: dispatched at `start`, started `queue` minutes later, verdict `review` minutes after that, priced at `usd`. */
interface Round {
  session: string;
  start: number;
  queue: number;
  review: number;
  verdict: string;
  usd: number;
}

function stepsOf(rounds: readonly Round[]): WorkflowRun["stepResults"] {
  const steps: WorkflowRun["stepResults"] = {};
  rounds.forEach((r, i) => {
    const started = r.start + r.queue * MIN;
    const done = started + r.review * MIN;
    const head = `h${i}`;
    steps[`sh-review:${head}:0`] = { stepId: "sh-review", iteration: 2 * i, agentId: null, signal: null, completedAt: new Date(started).toISOString(), data: { result: { kind: "dispatched", head, reviewer: `rv-${r.session}`, at: r.start, startedAt: started, sessionId: r.session } } };
    steps[`sh-await-verdict:${head}:0`] = { stepId: "sh-await-verdict", iteration: 2 * i + 1, agentId: null, signal: null, completedAt: new Date(done).toISOString(), data: { result: { kind: "verdict", verdict: r.verdict, head } } };
  });
  return steps;
}

function runOf(id: string, pr: number, rounds: readonly Round[], mergedAt?: number): WorkflowRun {
  const stepResults = stepsOf(rounds);
  const end = mergedAt ?? rounds.at(-1)!.start + 60 * MIN;
  if (mergedAt !== undefined) stepResults["merge:0"] = { stepId: "merge", iteration: 99, agentId: null, signal: null, completedAt: new Date(mergedAt).toISOString(), data: { result: { done: true } } };
  return { id, workflowName: "shepherd-pr", params: { repo: "Acme/Widgets", pr: String(pr) }, status: "completed", currentStep: null, stepResults, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: new Date(rounds[0]!.start).toISOString(), completedAt: new Date(end).toISOString(), error: null };
}

const round = (session: string, start: number, queue: number, review: number, verdict: string, usd: number): Round => ({ session, start, queue, review, verdict, usd });

/** Five reviews: PR 1 has three (two on day 1, one on day 2) and merges; PR 2 has two on day 1 and is still open. */
const PR1 = [round("s1", DAY1, 1, 10, "FIX_FIRST", 1), round("s2", DAY1 + 30 * MIN, 2, 20, "FIX_FIRST", 2), round("s3", DAY2, 3, 30, "MERGE", 3)];
const PR2 = [round("s4", DAY1 + 60 * MIN, 4, 40, "FIX_FIRST", 4), round("s5", DAY1 + 120 * MIN, 5, 50, "MERGE", 10)];

function fixture(): { db: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "review-stats-cli-"));
  const db = join(dir, "factory.sqlite3");
  openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
  const ledger = openDatabase(db);
  new WorkflowRunStore(ledger).create(runOf("run-1", 1, PR1, DAY2 + 40 * MIN));
  new WorkflowRunStore(ledger).create(runOf("run-2", 2, PR2));
  ledger.close();
  const logs = join(dir, "autonomy", "logs", "shepherd");
  mkdirSync(logs, { recursive: true });
  const retired = [...PR1, ...PR2].map((r) => JSON.stringify({ outcome: "retired", agent: `rv-${r.session}`, session_id: r.session, usd_est: r.usd, models: ["claude-opus-5-5"] }));
  writeFileSync(join(logs, "dispatch.jsonl"), `${retired.join("\n")}\n`);
  return { db, env: { AUTONOMY_ROOT: join(dir, "autonomy") } };
}

async function stats(fx: { db: string; env: Record<string, string> }, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(["--db", fx.db, "shepherd", "stats", "--reviews", ...args], { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env: fx.env });
  return { code, out: out.join(""), err: err.join("") };
}

/** A round with the labels the ledger gives it: its intent's cause, the member's shape, and whether its brief was scoped. */
interface Labelled {
  session: string;
  at: number;
  cause: string;
  shape?: string;
  scoped?: boolean;
  usd: number;
}

function labelledSteps(rounds: readonly Labelled[]): WorkflowRun["stepResults"] {
  const steps: WorkflowRun["stepResults"] = {};
  const stamp = (key: string, at: number, result: Record<string, unknown>) => (steps[key] = { stepId: key.replace(/:\d+$/, ""), iteration: 0, agentId: null, signal: null, completedAt: new Date(at).toISOString(), data: { result } });
  rounds.forEach((r, i) => {
    const head = `h${i}`;
    const member = r.shape === undefined ? "" : `:${r.shape}`;
    stamp(`sh-review-intent:${head}:0`, r.at, { kind: "intent", head, reviewer: `rv-${r.session}`, mode: "spawn", cause: { cause: r.cause } });
    stamp(`sh-review:${head}${member}:0`, r.at, { kind: "dispatched", head, reviewer: `rv-${r.session}`, at: r.at, startedAt: r.at, sessionId: r.session, ...(r.scoped !== undefined && { scoped: r.scoped }) });
    stamp(`sh-await-verdict:${head}${member}:0`, r.at + 10 * MIN, { kind: "verdict", verdict: "MERGE", head });
  });
  return steps;
}

const labelled = (session: string, at: number, cause: string, usd: number, extra: Partial<Labelled> = {}): Labelled => ({ session, at, cause, usd, ...extra });

/** Correctness: a first review, three fix rounds before the first scoped one, then a scoped and a full fix round; one adversary fix round. */
const LABELLED = [
  labelled("c1", DAY1, "first", 1),
  labelled("c2", DAY1 + 60 * MIN, "fix-round", 2),
  labelled("c3", DAY1 + 120 * MIN, "fix-round", 3),
  labelled("c4", DAY1 + 180 * MIN, "fix-round", 10),
  labelled("a1", DAY1 + 200 * MIN, "fix-round", 6, { shape: "adversary" }),
  labelled("c5", DAY2, "fix-round", 0.5, { scoped: true }),
  labelled("c6", DAY2 + 60 * MIN, "fix-round", 4, { scoped: false }),
];

function labelledFixture(): { db: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "review-stats-cli-"));
  const db = join(dir, "factory.sqlite3");
  openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
  const ledger = openDatabase(db);
  const run: WorkflowRun = { id: "run-1", workflowName: "shepherd-pr", params: { repo: "Acme/Widgets", pr: "1" }, status: "completed", currentStep: null, stepResults: labelledSteps(LABELLED), activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: new Date(DAY1).toISOString(), completedAt: new Date(DAY2 + 120 * MIN).toISOString(), error: null };
  new WorkflowRunStore(ledger).create(run);
  ledger.close();
  const logs = join(dir, "autonomy", "logs", "shepherd");
  mkdirSync(logs, { recursive: true });
  const usage = (usd: number) => ({ input: usd * 100_000, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, output: 0 });
  writeFileSync(join(logs, "dispatch.jsonl"), `${LABELLED.map((r) => JSON.stringify({ outcome: "retired", session_id: r.session, usd_est: r.usd, usage: usage(r.usd) })).join("\n")}\n`);
  return { db, env: { AUTONOMY_ROOT: join(dir, "autonomy") } };
}

describe("shepherd stats --reviews by cause and shape", () => {
  it("prints fix-round p50 and p90 dollars and tokens per shape, before and after the first scoped round, split scoped vs full", async () => {
    const report = JSON.parse((await stats(labelledFixture(), "--json")).out);

    expect(Object.keys(report.perReview.byCauseShape)).toEqual(["adversary fix-round", "correctness first", "correctness fix-round"]);
    expect(report.perReview.byCauseShape["correctness fix-round"]).toMatchObject({ n: 5, usd: { p50: 3 }, tokens: { p50: 300_000 } });
    expect(report.rereview.cutoff).toBe(new Date(DAY2 + 10 * MIN).toISOString());
    expect(report.rereview.cutoffFrom).toBe("first-scoped");
    expect(report.rereview.byShape.correctness).toEqual({
      before: { n: 3, unpriced: 0, usd: { p50: 3, p90: 10, total: 15 }, tokens: { p50: 300_000, p90: 1_000_000, total: 1_500_000 } },
      after: { n: 2, unpriced: 0, usd: { p50: 2.25, p90: 4, total: 4.5 }, tokens: { p50: 225_000, p90: 400_000, total: 450_000 } },
      afterScoped: { n: 1, unpriced: 0, usd: { p50: 0.5, p90: 0.5, total: 0.5 }, tokens: { p50: 50_000, p90: 50_000, total: 50_000 } },
      afterFull: { n: 1, unpriced: 0, usd: { p50: 4, p90: 4, total: 4 }, tokens: { p50: 400_000, p90: 400_000, total: 400_000 } },
    });
    expect(report.rereview.byShape.adversary.before).toMatchObject({ n: 1, usd: { p50: 6 } });
  });

  it("splits at --since-scoped when given, and prints the split in text mode", async () => {
    const fx = labelledFixture();

    const report = JSON.parse((await stats(fx, "--json", "--since-scoped", "2026-10-07")).out);
    const text = (await stats(fx, "--since-scoped", "2026-10-06")).out;

    expect(report.rereview).toMatchObject({ cutoff: "2026-10-07T00:00:00.000Z", cutoffFrom: "since-scoped" });
    expect(report.rereview.byShape.correctness.before.n).toBe(5);
    expect(report.rereview.byShape.correctness.after.n).toBe(0);
    expect(text).toContain("fix-round re-reviews, cutoff 2026-10-06T00:00:00.000Z (since-scoped):");
    expect(text).toContain("  correctness  after scoped n 1  usd p50 $0.50 p90 $0.50 total $0.50  tokens p50 50000 p90 50000");
  });
});

describe("shepherd stats --reviews", () => {
  it("prints the v1 shape with per-review distributions and their cuts, and per-PR totals summed over rounds", async () => {
    const fx = fixture();

    const { code, out } = await stats(fx, "--json");

    expect(code).toBe(0);
    const report = JSON.parse(out);
    expect(report).toMatchObject({ v: 1, range: { from: null, to: null, repo: null }, refresh: { added: 5, transcriptReads: 0 } });
    expect(report.perReview).toMatchObject({
      n: 5,
      unpriced: 0,
      usd: { p50: 3, p90: 10, mean: 4, total: 20 },
      reviewMinutes: { p50: 30, p90: 50, mean: 30, total: 150 },
      queueMinutes: { p50: 3, p90: 5, mean: 3, total: 15 },
      byVerdict: { FIX_FIRST: 3, MERGE: 2 },
    });
    expect(Object.keys(report.perReview.byRepo)).toEqual(["acme/widgets"]);
    expect(Object.keys(report.perReview.byWeek)).toEqual(["2026-W41"]);
    expect(report.perReview.byModel["claude-opus-5-5"].n).toBe(5);
    expect(report.perPr).toMatchObject({ n: 2, usd: { p50: 10, p90: 14, mean: 10 }, rounds: { p50: 2.5, p90: 3, mean: 2.5 } });
    expect(report.perPr.prs).toEqual([
      { repo: "acme/widgets", pr: 2, rounds: 2, usd: 14, reviewMinutes: 90, queueMinutes: 9, registeredToMergeMinutes: null, merged: false },
      { repo: "acme/widgets", pr: 1, rounds: 3, usd: 6, reviewMinutes: 60, queueMinutes: 6, registeredToMergeMinutes: 1480, merged: true },
    ]);
    expect(report.rows).toBeUndefined();
  });

  it("filters by verdict day with --from and --to", async () => {
    const fx = fixture();

    const day2 = JSON.parse((await stats(fx, "--json", "--from", "2026-10-06", "--to", "2026-10-06")).out);
    const day1 = JSON.parse((await stats(fx, "--json", "--to", "2026-10-05")).out);

    expect(day2.perReview.n).toBe(1);
    expect(day2.perPr.prs).toEqual([expect.objectContaining({ pr: 1, rounds: 1, usd: 3 })]);
    expect(day1.perReview.n).toBe(4);
    expect(day1.perReview.usd.total).toBe(17);
  });

  it("refreshes once and leaves a store that sqlite reads, with --rows printing every review", async () => {
    const fx = fixture();
    await stats(fx, "--json");

    const again = JSON.parse((await stats(fx, "--json", "--rows", "--repo", "ACME/widgets")).out);
    const store = openDatabase(join(fx.db, "..", REVIEW_STATS_DB), { readonly: true });
    const view = store.prepare("SELECT repo, pr, rounds, usd FROM pr_review ORDER BY pr").all();
    store.close();

    expect(again.refresh).toEqual({ added: 0, repriced: 0, transcriptReads: 0 });
    expect(again.rows).toHaveLength(5);
    expect(again.rows[0]).toMatchObject({ runId: "run-1", round: 0, sessionId: "s1", verdict: "FIX_FIRST", usd: 1, costSource: "retire", queueMinutes: 1, reviewMinutes: 10 });
    expect(view).toEqual([{ repo: "acme/widgets", pr: 1, rounds: 3, usd: 6 }, { repo: "acme/widgets", pr: 2, rounds: 2, usd: 14 }]);
  });

  it("prints the distribution and the PRs by cost in text mode", async () => {
    const { code, out } = await stats(fixture());

    expect(code).toBe(0);
    expect(out).toContain("reviews 5  unpriced 0  verdicts FIX_FIRST 3  MERGE 2");
    expect(out).toContain("usd        p50 $3.00  p90 $10.00  mean $4.00  total $20.00");
    expect(out.indexOf("acme/widgets#2")).toBeLessThan(out.indexOf("acme/widgets#1"));
    expect(out).toContain("refresh: 5 new reviews, 0 repriced, 0 transcript reads");
  });

  it("refuses --rows without --json and --repo without --reviews", async () => {
    const fx = fixture();

    const rows = await stats(fx, "--rows");
    const out: string[] = [];
    const err: string[] = [];
    const repo = await runCli(["--db", fx.db, "shepherd", "stats", "--repo", "acme/widgets"], { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env: fx.env });

    expect(rows).toMatchObject({ code: 2, err: "error: --rows prints JSON only; add --json\n" });
    expect(repo).toBe(2);
    expect(err.join("")).toBe("error: --repo, --rows and --since-scoped apply only to --reviews\n");
  });
});
