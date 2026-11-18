import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { WorkflowRunStore, workflowMigration, workflowOwnershipMigration, type WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { ReviewStatsStore, REVIEW_STATS_DB, REVIEW_STATS_MIGRATIONS } from "./review-stats-store.js";
import { ledgerRuns, refreshReviewStats } from "./review-stats.js";

const T0 = Date.parse("2026-10-05T10:00:00Z");
const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const SESSION = { a: "aaaaaaaa-0000-4000-8000-000000000001", b: "bbbbbbbb-0000-4000-8000-000000000002" };

type Step = [string, number, Record<string, unknown>];

const dispatched = (session: string, head: string, minutes: number) => ({ kind: "dispatched", head, reviewer: `rv-${head}`, mode: "spawn", at: T0 + minutes * 60_000, startedAt: T0 + minutes * 60_000, agentId: "r", sessionId: session });
const verdict = (session: string, head: string, value: string) => ({ kind: "verdict", verdict: value, head, locator: { source: { path: `/t/${session}.jsonl`, conversation: { nativeId: session } } } });

/** h1 reviewed MERGE, then h2, a merge of main whose own diff is h1's, reviewed again. */
const mergeOnlyRun = (): WorkflowRun => {
  const steps: Step[] = [
    ["sh-own-diff:h1:0", 0, { id: "id-x", base: "b".repeat(40) }],
    ["sh-review:h1:0", 1, dispatched(SESSION.a, "h1", 0)],
    ["sh-await-verdict:h1:0", 5, verdict(SESSION.a, "h1", "MERGE")],
    ["sh-own-diff:h2:0", 10, { id: "id-x", base: "c".repeat(40) }],
    ["sh-review:h2:0", 11, dispatched(SESSION.b, "h2", 10)],
    ["sh-await-verdict:h2:0", 15, verdict(SESSION.b, "h2", "MERGE")],
  ];
  const stepResults: WorkflowRun["stepResults"] = {};
  steps.forEach(([key, minutes, result], index) => {
    stepResults[key] = { stepId: key.split(":")[0]!, iteration: index, agentId: null, signal: null, completedAt: iso(minutes), data: { result } };
  });
  return { id: "r1", workflowName: "shepherd-pr", params: { repo: "acme/widgets", pr: "7" }, status: "completed", currentStep: null, stepResults, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: iso(0), completedAt: iso(20), error: null };
};

describe("ReviewStatsStore", () => {
  it("a v3 store migrates to v4 and refills", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "review-stats-store-")), REVIEW_STATS_DB);
    const v3 = openDatabase(file);
    runMigrations(v3, REVIEW_STATS_MIGRATIONS.slice(0, 3));
    v3.prepare("INSERT INTO review (run_id, round, repo, pr, head_sha, session_id, requested_at, verdict, usd, cost_source, shape) VALUES ('r1', 1, 'acme/widgets', 7, 'h2', ?, 0, 'MERGE', 0.25, 'retire', 'correctness')").run(SESSION.b);
    v3.prepare("INSERT INTO review_meta (key, value) VALUES ('refreshed_through', ?)").run(iso(999));
    v3.close();
    const ledger = openDatabase(":memory:");
    runMigrations(ledger, [workflowMigration(1), workflowOwnershipMigration(2)]);
    new WorkflowRunStore(ledger).create(mergeOnlyRun());

    const store = ReviewStatsStore.open(file);
    const watermark = store.refreshedThrough();
    await refreshReviewStats({ store, runs: ledgerRuns(ledger), retire: new Map(), transcripts: { read: async () => ({ ok: false, reason: "none" }) } });

    expect(watermark).toBeUndefined();
    expect(store.db.prepare("SELECT round, usd, own_diff_id, unchanged_since_verdict FROM review ORDER BY round").all()).toEqual([
      { round: 0, usd: null, own_diff_id: "id-x", unchanged_since_verdict: null },
      { round: 1, usd: 0.25, own_diff_id: "id-x", unchanged_since_verdict: "after-MERGE" },
    ]);
    expect(store.db.prepare("SELECT passes, unchanged_passes, unchanged_usd FROM pr_review").get()).toEqual({ passes: 2, unchanged_passes: 1, unchanged_usd: 0.25 });
  });

  it("opening a v4 store again runs no migration and keeps its rows", () => {
    const file = join(mkdtempSync(join(tmpdir(), "review-stats-store-")), REVIEW_STATS_DB);
    ReviewStatsStore.open(file).close();
    const again = ReviewStatsStore.open(file);

    expect(again.db.prepare("SELECT COUNT(*) AS n FROM review").get()).toEqual({ n: 0 });
  });
});
