import { describe, expect, it } from "vitest";
import { poolReports, shepherdReport, worktreesReport } from "./report-sections.js";

const NOW = new Date("2026-10-12T16:40:00Z");

describe("poolReports", () => {
  it("ages each reading against now and nulls what is absent", () => {
    const rows = poolReports(
      [
        { pool: "alpha", fiveHour: { value: 40, readAt: "2026-10-12T16:30:00Z" }, band: "green", pace: 1.2 },
        { pool: "beta", sevenDay: { value: 70, readAt: "2026-10-12T17:00:00Z" }, reserve: "keep-hand" },
      ],
      NOW,
    );

    expect(rows).toEqual([
      { pool: "alpha", fiveHour: { value: 40, ageMinutes: 10 }, sevenDay: null, band: "green", pace: 1.2, reserve: null },
      { pool: "beta", fiveHour: null, sevenDay: { value: 70, ageMinutes: 0 }, band: null, pace: null, reserve: "keep-hand" },
    ]);
  });

  it("reports no pools for no rows", () => {
    expect(poolReports([], NOW)).toEqual([]);
  });
});

describe("worktreesReport", () => {
  it("subtracts left-free from the ceiling and repeats the per-repo cap on each repo", () => {
    const out = worktreesReport({
      active: { "demo/a": 2, "demo/b": 1 },
      perRepoPerSeat: 3,
      totalCeiling: 10,
      leftFree: 2,
      budget: 12,
    });

    expect(out).toEqual({
      repos: { "demo/a": { active: 2, perRepoPerSeat: 3 }, "demo/b": { active: 1, perRepoPerSeat: 3 } },
      ceiling: 8,
      budget: 12,
    });
  });

  it("reports a null ceiling, budget and cap when the broker gives none", () => {
    expect(worktreesReport({ active: { "demo/a": 1 } })).toEqual({
      repos: { "demo/a": { active: 1, perRepoPerSeat: null } },
      ceiling: null,
      budget: null,
    });
  });
});

describe("shepherdReport", () => {
  it("is null when the caller made no read", () => {
    expect(shepherdReport(undefined)).toBeNull();
  });

  it("yields {error} for an error read", () => {
    expect(shepherdReport({ error: "shepherd unreachable" })).toEqual({ error: "shepherd unreachable" });
  });

  it("tallies runs by phase, lists held runs and counts reviews in flight against the cap", () => {
    const out = shepherdReport({
      runs: [
        { id: "r1", phase: "review", reviewInFlight: true },
        { id: "r2", phase: "review", reviewInFlight: true, holdReason: "needs owner" },
        { id: "r3", phase: "ci" },
      ],
      maxConcurrent: 2,
    });

    expect(out).toEqual({
      runs: { review: 2, ci: 1 },
      held: [{ run: "r2", reason: "needs owner" }],
      reviews: { inFlight: 2, maxConcurrent: 2 },
    });
  });

  it("reports a null review cap when none is supplied", () => {
    expect(shepherdReport({ runs: [] })).toEqual({ runs: {}, held: [], reviews: { inFlight: 0, maxConcurrent: null } });
  });
});
