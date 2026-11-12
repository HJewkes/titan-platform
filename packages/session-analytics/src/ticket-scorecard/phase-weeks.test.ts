import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { phaseWeeks, type PhaseRun } from "./phase-weeks.js";
import { readPhaseWeeks, upsertPhaseWeeks } from "./run-store.js";
import { SCORECARD_MIGRATIONS } from "./store.js";

const runs: PhaseRun[] = [
  { runId: "r1", repo: "acme/widgets", completedAt: "2026-11-10T10:00:00.000Z", stageMinutes: { ci: 10, review: 30 } },
  { runId: "r2", repo: "acme/widgets", completedAt: "2026-11-11T10:00:00.000Z", stageMinutes: { ci: 20 } },
  { runId: "r3", repo: "acme/gadgets", completedAt: "2026-11-12T10:00:00.000Z", stageMinutes: { ci: 40 } },
  { runId: "r4", repo: "acme/widgets", completedAt: null, stageMinutes: { ci: 999 } },
];

describe("shepherd phase weeks", () => {
  it("phase medians count finished runs only, per week, repo and stage", () => {
    const cells = phaseWeeks(runs);

    const ci = cells.filter((c) => c.stage === "ci");
    expect(ci).toEqual([
      { isoWeek: "2026-W46", repo: "acme/gadgets", stage: "ci", runs: 1, medianMinutes: 40, p90Minutes: 40 },
      { isoWeek: "2026-W46", repo: "acme/widgets", stage: "ci", runs: 2, medianMinutes: 10, p90Minutes: 20 },
      { isoWeek: "2026-W46", repo: "all", stage: "ci", runs: 3, medianMinutes: 20, p90Minutes: 40 },
    ]);
    expect(phaseWeeks([...runs].reverse())).toEqual(cells);
  });

  it("an unchanged phase cell is not rewritten", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, SCORECARD_MIGRATIONS);

    const first = upsertPhaseWeeks(db, phaseWeeks(runs), "2026-11-12T00:00:00.000Z");
    const second = upsertPhaseWeeks(db, phaseWeeks(runs), "2026-11-13T00:00:00.000Z");

    expect(first).toBe(phaseWeeks(runs).length);
    expect(second).toBe(0);
    expect(readPhaseWeeks(db)).toEqual(phaseWeeks(runs));
    db.close();
  });
});
