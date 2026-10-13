import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USAGE_LIMIT_REASON } from "@titan-design/review-panel";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { WorkflowRunStore, workflowMigration, workflowOwnershipMigration, type WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { ReviewStatsStore, REVIEW_STATS_DB } from "./review-stats-store.js";
import { ledgerRuns, readRetireCosts, refreshReviewStats } from "./review-stats.js";
import type { SessionRead, TranscriptPort } from "./stats-cost.js";

const T0 = Date.parse("2026-10-05T10:00:00Z");
const MIN = 60_000;
const at = (minutes: number): number => T0 + minutes * MIN;
const iso = (minutes: number): string => new Date(at(minutes)).toISOString();
const MTOK = 1_000_000;
const SESSION = { a: "aaaaaaaa-0000-4000-8000-000000000001", b: "bbbbbbbb-0000-4000-8000-000000000002", c: "cccccccc-0000-4000-8000-000000000003" };

type Step = [string, number, Record<string, unknown>];

const dispatched = (session: string, head: string, minutes: number, startedMinutes: number) => ({ kind: "dispatched", head, reviewer: `rv-${head}`, mode: "spawn", at: at(minutes), startedAt: at(startedMinutes), agentId: "r", sessionId: session });
const verdict = (session: string, head: string, value: string) => ({ kind: "verdict", verdict: value, head, locator: { source: { path: `/t/${session}.jsonl`, conversation: { nativeId: session } } } });
const limited = { kind: "none", reason: USAGE_LIMIT_REASON, notice: "You've hit your limit" };
const timedOut = { kind: "none", reason: "timeout" };
const reviewed = (head: string, session: string, from: number, started: number, to: number, value: string): Step[] => [
  [`sh-review:${head}:0`, started, dispatched(session, head, from, started)],
  [`sh-await-verdict:${head}:0`, to, verdict(session, head, value)],
];

function runOf(id: string, steps: Step[], status: WorkflowRun["status"] = "completed", completed = 45): WorkflowRun {
  const stepResults: WorkflowRun["stepResults"] = {};
  steps.forEach(([key, minutes, result], index) => {
    stepResults[key] = { stepId: key.split(":")[0]!, iteration: index, agentId: null, signal: null, completedAt: iso(minutes), data: { result } };
  });
  const done = status === "completed" || status === "failed" || status === "cancelled";
  return { id, workflowName: "shepherd-pr", params: { repo: "Acme/Widgets", pr: "7" }, status, currentStep: null, stepResults, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: iso(0), completedAt: done ? iso(completed) : null, error: null };
}

/** Round 0 priced from a retire row, a usage-limit-only head, then round 2 priced from its transcript, then the merge. */
const twoRounds = (): Step[] => [
  ...reviewed("h1", SESSION.a, 0, 2, 10, "FIX_FIRST"),
  ["sh-review:h2:0", 12, dispatched(SESSION.c, "h2", 12, 12)],
  ["sh-await-verdict:h2:0", 14, limited],
  ...reviewed("h3", SESSION.b, 20, 21, 30, "MERGE"),
  ["merge:0", 40, { done: true }],
];

function ledger(runs: WorkflowRun[]): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [workflowMigration(1), workflowOwnershipMigration(2)]);
  for (const run of runs) new WorkflowRunStore(db).create(run);
  return db;
}

function logsWith(rows: Record<string, unknown>[]): string {
  const logs = join(mkdtempSync(join(tmpdir(), "review-stats-")), "logs");
  mkdirSync(join(logs, "shepherd"), { recursive: true });
  writeFileSync(join(logs, "shepherd", "dispatch.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return logs;
}

const retireRow = (session: string, usd: number) => ({ ts: "2026-10-05T10:11:00Z", outcome: "retired", agent: "rv-h1", session_id: session, usd_est: usd, tokens: 3000, models: ["claude-opus-5-5"], usage: { input: 1000, cache_read: 500, cache_write_5m: 300, cache_write_1h: 200, output: 1000 } });

function portOf(reads: Record<string, SessionRead>): TranscriptPort & { paths: string[] } {
  const paths: string[] = [];
  return { paths, read: async (path) => (paths.push(path), reads[path] ?? { ok: false, reason: "missing transcript" }) };
}

const haikuOut = (responseId: string, minutes: number) => ({ responseId, model: "claude-haiku-4-5", at: iso(minutes), tokens: { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: MTOK } });
const transcriptB = (): Record<string, SessionRead> => ({ [`/t/${SESSION.b}.jsonl`]: { ok: true, requests: [haikuOut("m1", 25), haikuOut("m-before", 15)] } });

function storeFile(): ReviewStatsStore {
  return ReviewStatsStore.open(join(mkdtempSync(join(tmpdir(), "review-stats-")), REVIEW_STATS_DB));
}

const reviewRows = (store: ReviewStatsStore) =>
  store.db.prepare("SELECT round, repo, pr, head_sha, session_id, model, queue_ms, review_ms, verdict, input, cache_write, usd, cost_source FROM review ORDER BY round").all();

describe("refreshReviewStats", () => {
  it("writes one row per review round, priced from its retire row or else once from its transcript, and skips a usage-limit-only head", async () => {
    const store = storeFile();
    const port = portOf(transcriptB());

    const result = await refreshReviewStats({ store, runs: ledgerRuns(ledger([runOf("r1", twoRounds())])), retire: readRetireCosts(logsWith([retireRow(SESSION.a, 1.5)])), transcripts: port });

    expect(result).toEqual({ added: 2, repriced: 0, transcriptReads: 1 });
    expect(reviewRows(store)).toEqual([
      { round: 0, repo: "acme/widgets", pr: 7, head_sha: "h1", session_id: SESSION.a, model: "claude-opus-5-5", queue_ms: 2 * MIN, review_ms: 8 * MIN, verdict: "FIX_FIRST", input: 1000, cache_write: 500, usd: 1.5, cost_source: "retire" },
      { round: 2, repo: "acme/widgets", pr: 7, head_sha: "h3", session_id: SESSION.b, model: "claude-haiku-4-5", queue_ms: 1 * MIN, review_ms: 9 * MIN, verdict: "MERGE", input: 0, cache_write: 0, usd: 5, cost_source: "transcript" },
    ]);
  });

  it("makes no transcript read and adds no row on a second refresh", async () => {
    const store = storeFile();
    const runs = ledgerRuns(ledger([runOf("r1", twoRounds())]));
    const deps = { store, runs, retire: readRetireCosts(logsWith([retireRow(SESSION.a, 1.5)])), transcripts: portOf(transcriptB()) };
    await refreshReviewStats(deps);
    const again = portOf(transcriptB());

    const result = await refreshReviewStats({ ...deps, transcripts: again });

    expect(result).toEqual({ added: 0, repriced: 0, transcriptReads: 0 });
    expect(again.paths).toEqual([]);
    expect(reviewRows(store)).toHaveLength(2);
  });

  it("never re-reads a run that finished before the watermark", async () => {
    const store = storeFile();
    const deps = { store, runs: ledgerRuns(ledger([runOf("r1", twoRounds(), "completed", 45), runOf("r2", reviewed("h9", SESSION.c, 0, 1, 5, "MERGE"), "completed", 10)])), retire: new Map(), transcripts: portOf(transcriptB()) };
    await refreshReviewStats(deps);
    store.db.prepare("DELETE FROM review WHERE run_id = 'r2'").run();

    const result = await refreshReviewStats(deps);

    expect(store.refreshedThrough()).toBe(iso(45));
    expect(result.added).toBe(0);
  });

  it("holds a round of an unfinished run until a verdict resolves it", async () => {
    const store = storeFile();
    const waiting: Step[] = [["sh-review:h1:0", 1, dispatched(SESSION.a, "h1", 0, 1)], ["sh-await-verdict:h1:0", 20, timedOut]];
    const retire = readRetireCosts(logsWith([retireRow(SESSION.a, 2)]));
    await refreshReviewStats({ store, runs: ledgerRuns(ledger([runOf("r1", waiting, "running")])), retire, transcripts: portOf({}) });
    expect(reviewRows(store)).toEqual([]);

    const late: Step = ["sh-late-verdict:h1:0", 25, verdict(SESSION.a, "h1", "MERGE")];
    const result = await refreshReviewStats({ store, runs: ledgerRuns(ledger([runOf("r1", [...waiting, late], "running")])), retire, transcripts: portOf({}) });

    expect(result.added).toBe(1);
    expect(reviewRows(store)).toEqual([expect.objectContaining({ verdict: "MERGE", review_ms: 24 * MIN, usd: 2, cost_source: "retire" })]);
  });

  it("prices a stored unpriced round from a retire row written since, without a transcript read", async () => {
    const store = storeFile();
    const runs = ledgerRuns(ledger([runOf("r1", reviewed("h1", SESSION.a, 0, 1, 5, "MERGE"))]));
    await refreshReviewStats({ store, runs, retire: new Map(), transcripts: portOf({}) });

    const port = portOf({});
    const result = await refreshReviewStats({ store, runs, retire: readRetireCosts(logsWith([retireRow(SESSION.a, 0.75)])), transcripts: port });

    expect(result).toEqual({ added: 0, repriced: 1, transcriptReads: 0 });
    expect(reviewRows(store)).toEqual([expect.objectContaining({ usd: 0.75, cost_source: "retire" })]);
  });

  it("splits a session that served two rounds by transcript window rather than charging its retire row twice", async () => {
    const store = storeFile();
    const steps = [...reviewed("h1", SESSION.b, 0, 0, 10, "FIX_FIRST"), ...reviewed("h2", SESSION.b, 20, 20, 30, "MERGE")];
    const port = portOf({ [`/t/${SESSION.b}.jsonl`]: { ok: true, requests: [haikuOut("m1", 5), haikuOut("m2", 25)] } });

    await refreshReviewStats({ store, runs: ledgerRuns(ledger([runOf("r1", steps)])), retire: readRetireCosts(logsWith([retireRow(SESSION.b, 9)])), transcripts: port });

    expect(reviewRows(store)).toEqual([expect.objectContaining({ usd: 5, cost_source: "transcript" }), expect.objectContaining({ usd: 5, cost_source: "transcript" })]);
  });
});

describe("pr_review view", () => {
  it("sums each PR's rounds, cost and review time across its runs, with its registration and merge", async () => {
    const store = storeFile();
    const runs = [runOf("r1", twoRounds()), { ...runOf("r0", reviewed("h0", SESSION.c, 0, 0, 4, "FIX_FIRST"), "cancelled", 5) }];
    await refreshReviewStats({ store, runs: ledgerRuns(ledger(runs)), retire: readRetireCosts(logsWith([retireRow(SESSION.a, 1.5), retireRow(SESSION.c, 0.5)])), transcripts: portOf(transcriptB()) });

    const rows = store.db.prepare("SELECT * FROM pr_review").all();

    expect(rows).toEqual([{ repo: "acme/widgets", pr: 7, rounds: 3, usd: 7, review_ms: 21 * MIN, queue_ms: 3 * MIN, registered_at: at(0), merged_at: at(40) }]);
  });
});

describe("readRetireCosts", () => {
  it("reads priced retire rows from every seat's log and ignores dispatched rows, unpriced retires and bad lines", () => {
    const logs = logsWith([{ outcome: "dispatched", agent: "rv-x", session_id: SESSION.a }, { outcome: "retired", session_id: SESSION.b, usd_est: null, usage_miss: "no transcript" }, retireRow(SESSION.a, 1)]);
    writeFileSync(join(logs, "shepherd", "dispatch.jsonl"), "not json\n", { flag: "a" });
    mkdirSync(join(logs, "seat-a"));
    writeFileSync(join(logs, "seat-a", "dispatch.jsonl"), `${JSON.stringify(retireRow(SESSION.c, 2))}\n`);

    const costs = readRetireCosts(logs);

    expect([...costs.keys()].sort()).toEqual([SESSION.a, SESSION.c]);
    expect(costs.get(SESSION.a)).toEqual({ usd: 1, tokens: { input: 1000, cacheRead: 500, cacheWrite: 500, output: 1000 }, model: "claude-opus-5-5" });
  });
});
