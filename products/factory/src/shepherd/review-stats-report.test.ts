import { describe, expect, it } from "vitest";
import { formatReviewReport, reviewReport } from "./review-stats-report.js";
import { ReviewStatsStore, type ReviewRow } from "./review-stats-store.js";

const T0 = Date.parse("2026-10-05T10:00:00Z");

const row = (pr: number, round: number, verdict: string, usd: number | null, unchangedSinceVerdict: string | null): ReviewRow => ({
  runId: `run-${pr}`, round, repo: "acme/widgets", pr, headSha: `h${round}`, reviewer: "rv", sessionId: `s-${pr}-${round}`, model: null,
  requestedAt: T0 + round * 60_000, startedAt: null, verdictAt: T0 + round * 60_000, queueMs: null, reviewMs: null, verdict, tokens: null, usd,
  costSource: usd === null ? null : "retire", cause: null, shape: "correctness", scoped: null, scopeUntagged: null, scopeRepeated: null,
  ownDiffId: unchangedSinceVerdict === null ? null : "id-x", unchangedSinceVerdict,
});

function storeWith(rows: readonly ReviewRow[]): ReviewStatsStore {
  const store = ReviewStatsStore.open(":memory:");
  for (const each of rows) store.upsertReview(each);
  return store;
}

describe("reviewReport", () => {
  it("per-PR rows list passes, usd and unchanged passes", () => {
    const store = storeWith([
      row(1, 0, "FIX_FIRST", 1, null), row(1, 1, "MERGE", 0.5, "after-FIX_FIRST"), row(1, 2, "MERGE", 0.25, "after-MERGE"), row(1, 3, "none", null, null),
      row(2, 0, "MERGE", 2, null), row(2, 1, "MERGE", 1, "changed"),
    ]);

    const report = reviewReport(store.db, {}, T0);

    expect(report.perPr.prs).toEqual([
      expect.objectContaining({ pr: 2, rounds: 2, passes: 2, usd: 3, unchangedPasses: 0, unchangedUsd: null }),
      expect.objectContaining({ pr: 1, rounds: 4, passes: 3, usd: 1.75, unchangedPasses: 2, unchangedUsd: 0.75 }),
    ]);
    expect(report.perPr.passes).toEqual({ p50: 2.5, p90: 3, mean: 2.5, total: 5 });
    expect(report.unchanged).toEqual({ passes: 2, usd: 0.75, afterMerge: 1, afterFixFirst: 1, top: [expect.objectContaining({ pr: 1 })] });
  });

  it("prints the pass totals, the unchanged share and the top PRs by unchanged passes", () => {
    const store = storeWith([row(1, 0, "MERGE", 1, null), row(1, 1, "MERGE", 0.5, "after-MERGE")]);

    const text = formatReviewReport(reviewReport(store.db, {}, T0));

    expect(text).toContain("passes 2  per PR p50 2 mean 2 p90 2  unchanged 1 $0.50 (after MERGE 1, after FIX_FIRST 0)");
    expect(text).toContain("top 10 PRs by unchanged passes:\n  acme/widgets#1  rounds 2  passes 2  $1.50  unchanged 1 $0.50");
  });
});
