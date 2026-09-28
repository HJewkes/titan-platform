import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { costReport, resolveWindow } from "./cost-report.js";
import { readCostRows } from "./cost-report-queries.js";
import { createFixtureGraph, seedCostScenario, type FixtureGraph } from "./fixture.js";

let fixture: FixtureGraph;

beforeEach(() => {
  fixture = createFixtureGraph();
  seedCostScenario(fixture);
});
afterEach(() => fixture.close());

describe("cost report window", () => {
  it("since and until filter on request ts", () => {
    const db = fixture.openReadOnly();
    const all = readCostRows(db, { since: null, until: null });
    const day = readCostRows(db, { since: "2026-09-20", until: "2026-09-21" });
    const lateOnly = costReport(db, { since: "2026-09-21T00:00:00Z" });

    expect(all).toHaveLength(8);
    expect(day).toHaveLength(6);
    expect(day.every((row) => row.inputTokens !== 999_999)).toBe(true);
    expect(lateOnly.totals).toMatchObject({ requests: 1, sessions: 1 });
    expect(lateOnly.compactions.total).toBe(1);
    expect(readCostRows(db, { since: "2026-09-19T23:59:59Z", until: "2026-09-21T00:00:00Z" })).toHaveLength(7);
  });

  it("derives since from days before until, or before now", () => {
    expect(resolveWindow({ days: 2, until: "2026-09-21T00:00:00.000Z" })).toEqual({ since: "2026-09-19T00:00:00.000Z", until: "2026-09-21T00:00:00.000Z" });
    expect(resolveWindow({ days: 1, now: new Date("2026-09-22T06:00:00.000Z") })).toEqual({ since: "2026-09-21T06:00:00.000Z", until: null });
    expect(resolveWindow({ since: "2026-09-01", days: 1 })).toEqual({ since: "2026-09-01", until: null });
  });

  it("prices a split-less cache write at the 5m rate, as the view does", () => {
    const sonnet = readCostRows(fixture.openReadOnly(), { since: null, until: null }).find((row) => row.model === "claude-sonnet-5")!;

    expect(sonnet.cacheWrite5mTokens).toBe(2_000);
    expect(sonnet.cacheWrite5mCostUsd).toBeCloseTo((2_000 * 2.5) / 1e6, 12);
  });
});
