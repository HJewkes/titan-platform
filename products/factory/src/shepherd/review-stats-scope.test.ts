import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { WorkflowRunStore, workflowMigration, workflowOwnershipMigration, type WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { reviewReport } from "./review-stats-report.js";
import { ReviewStatsStore, REVIEW_STATS_DB } from "./review-stats-store.js";
import { ledgerRuns, refreshReviewStats } from "./review-stats.js";

const T0 = Date.parse("2026-10-05T10:00:00Z");
const at = (minutes: number): number => T0 + minutes * 60_000;
const SESSION = { a: "aaaaaaaa-0000-4000-8000-000000000001", b: "bbbbbbbb-0000-4000-8000-000000000002", c: "cccccccc-0000-4000-8000-000000000003" };

type Step = [string, number, Record<string, unknown>];

const intent = (head: string, cause: string) => ({ kind: "intent", head, reviewer: `rv-${head}`, mode: "spawn", cause: { cause } });
const dispatched = (session: string, head: string, minutes: number) => ({ kind: "dispatched", head, reviewer: `rv-${head}`, mode: "spawn", at: at(minutes), startedAt: at(minutes), agentId: "r", sessionId: session });
const verdict = (session: string, head: string, value: string) => ({ kind: "verdict", verdict: value, head, locator: { source: { path: `/t/${session}.jsonl`, conversation: { nativeId: session } } } });
const checked = (minutes: number, untagged: number, repeated: number, kept = false) => ({ kind: "checked", mode: "on", untagged, repeated, at: at(minutes), ...(kept && { kept }) });

/** A panel's first review at h1, then its fix round at h2, whose correctness `sh-review` result is `h2Review`. */
const fixRound = (h2Review: Record<string, unknown>, h2Correctness: Step[]): Step[] => [
  ["sh-review-intent:h1:0", 0, intent("h1", "first")],
  ["sh-review:h1:0", 1, dispatched(SESSION.a, "h1", 0)],
  ["sh-review:h1:adversary:0", 1, dispatched(SESSION.b, "h1", 0)],
  ["sh-await-verdict:h1:0", 5, verdict(SESSION.a, "h1", "FIX_FIRST")],
  ["sh-await-verdict:h1:adversary:0", 6, verdict(SESSION.b, "h1", "MERGE")],
  ["sh-review-intent:h2:0", 10, intent("h2", "fix-round")],
  ["sh-review:h2:0", 11, { ...dispatched(SESSION.c, "h2", 10), ...h2Review }],
  ["sh-review:h2:adversary:0", 11, dispatched(SESSION.b, "h2", 10)],
  ...h2Correctness,
  ["sh-await-verdict:h2:adversary:0", 18, verdict(SESSION.b, "h2", "MERGE")],
];

function refreshed(steps: Step[]): Promise<ReviewStatsStore> {
  const ledger: Db = openDatabase(":memory:");
  runMigrations(ledger, [workflowMigration(1), workflowOwnershipMigration(2)]);
  const stepResults: WorkflowRun["stepResults"] = {};
  steps.forEach(([key, minutes, result], index) => {
    stepResults[key] = { stepId: key.split(":")[0]!, iteration: index, agentId: null, signal: null, completedAt: new Date(at(minutes)).toISOString(), data: { result } };
  });
  new WorkflowRunStore(ledger).create({ id: "r1", workflowName: "shepherd-pr", params: { repo: "Acme/Widgets", pr: "7" }, status: "completed", currentStep: null, stepResults, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: new Date(T0).toISOString(), completedAt: new Date(at(45)).toISOString(), error: null });
  const store = ReviewStatsStore.open(join(mkdtempSync(join(tmpdir(), "review-stats-scope-")), REVIEW_STATS_DB));
  return refreshReviewStats({ store, runs: ledgerRuns(ledger), retire: new Map(), transcripts: { read: async () => ({ ok: false, reason: "missing transcript" }) } }).then(() => store);
}

describe("review stats for scoped fix rounds", () => {
  it("stores a shadow-scoped fix round as full, so the first-scoped cutoff waits for a round whose brief was scoped", async () => {
    const store = await refreshed(fixRound({ scoped: true, scopeShadow: true }, [["sh-await-verdict:h2:0", 15, verdict(SESSION.c, "h2", "MERGE")]]));

    expect(store.db.prepare("SELECT scoped FROM review WHERE head_sha = 'h2' AND shape = 'correctness'").get()).toEqual({ scoped: 0 });
    expect(reviewReport(store.db, {}, at(60)).rereview).toMatchObject({ cutoff: null, cutoffFrom: "none" });
  });

  it("still stores an on-scoped fix round as scoped", async () => {
    const store = await refreshed(fixRound({ scoped: true }, [["sh-await-verdict:h2:0", 15, verdict(SESSION.c, "h2", "MERGE")]]));

    expect(store.db.prepare("SELECT scoped FROM review WHERE head_sha = 'h2' AND shape = 'correctness'").get()).toEqual({ scoped: 1 });
    expect(reviewReport(store.db, {}, at(60)).rereview).toMatchObject({ cutoffFrom: "first-scoped" });
  });

  it("records the first scope check's counts on the correctness round, not the corrected reply's, and sums them per week", async () => {
    const store = await refreshed(
      fixRound({ scoped: true }, [
        ["sh-await-verdict:h2:0", 15, verdict(SESSION.c, "h2", "FIX_FIRST")],
        ["sh-scope-check:h2:0", 15, checked(15, 2, 1)],
        ["sh-correct-verdict:h2:scope-1:0", 16, { kind: "asked", startedAt: at(16) }],
        ["sh-await-verdict:h2:scope-1:0", 17, verdict(SESSION.c, "h2", "FIX_FIRST")],
        ["sh-scope-check:h2:reply-1:0", 17, checked(17, 1, 0, true)],
      ]),
    );

    expect(store.db.prepare("SELECT shape, scope_untagged, scope_repeated FROM review WHERE head_sha = 'h2' ORDER BY round").all()).toEqual([
      { shape: "correctness", scope_untagged: 2, scope_repeated: 1 },
      { shape: "adversary", scope_untagged: null, scope_repeated: null },
    ]);
    expect(reviewReport(store.db, {}, at(60)).scopeCheckByWeek).toEqual({ "2026-W41": { checked: 1, untagged: 2, repeated: 1 } });
  });
});
