import { describe, expect, it } from "vitest";
import type { Bet } from "./planning.js";
import { checkPrediction, orderBetsForSheet, type ScorecardWeekRow } from "./prediction-check.js";

function bet(overrides: Partial<Bet> & { prediction?: Partial<Bet["prediction"]> } = {}): Bet {
  const { prediction, ...rest } = overrides;
  return {
    id: "alpha/B1",
    initiative: "alpha",
    week: "2026-W47",
    outcome: "alpha/faster-landing",
    order: 1,
    tasks: ["alpha/AL-1"],
    state: "selected",
    ...rest,
    prediction: { metric: "reverts", direction: "decrease", baseline: 6, expected: 2, read_by: "2026-11-30", ...prediction },
  };
}

function row(metrics: Record<string, number | null>, overrides: Partial<ScorecardWeekRow> = {}): ScorecardWeekRow {
  return { isoWeek: "2026-W47", dimension: "initiative", key: "alpha", metrics, ...overrides };
}

describe("checkPrediction", () => {
  it("confirms a decrease prediction when the week reads at or below expected", () => {
    const result = checkPrediction(bet(), [row({ reverts: 2 })]);

    expect(result).toBe("confirmed");
  });

  it("misses a decrease prediction when the week reads above expected", () => {
    const result = checkPrediction(bet(), [row({ reverts: 3 })]);

    expect(result).toBe("missed");
  });

  it("confirms an increase prediction when the week reads at or above expected", () => {
    const result = checkPrediction(bet({ prediction: { direction: "increase", baseline: 1, expected: 5 } }), [row({ reverts: 5 })]);

    expect(result).toBe("confirmed");
  });

  it("misses an increase prediction when the week reads below expected", () => {
    const result = checkPrediction(bet({ prediction: { direction: "increase", baseline: 1, expected: 5 } }), [row({ reverts: 4 })]);

    expect(result).toBe("missed");
  });

  it("is unread when no row carries the predicted metric", () => {
    const result = checkPrediction(bet(), [row({ merged: 4 })]);

    expect(result).toBe("unread");
  });

  it("is unread when the metric is null because nothing was measured", () => {
    const result = checkPrediction(bet(), [row({ reverts: null })]);

    expect(result).toBe("unread");
  });

  it("is unread when the only rows belong to another week or another initiative", () => {
    const rows = [row({ reverts: 0 }, { isoWeek: "2026-W46" }), row({ reverts: 0 }, { key: "beta" }), row({ reverts: 0 }, { dimension: "all", key: "all" })];

    expect(checkPrediction(bet(), rows)).toBe("unread");
  });
});

describe("orderBetsForSheet", () => {
  it("sorts a missed prediction before a new bet in the same area", () => {
    const missed = bet({ id: "alpha/B1", order: 5, state: "done" });
    const fresh = bet({ id: "alpha/B2", order: 1, state: "proposed" });

    const ordered = orderBetsForSheet([{ bet: fresh }, { bet: missed, check: "missed" }]);

    expect(ordered.map((entry) => entry.bet.id)).toEqual(["alpha/B1", "alpha/B2"]);
  });

  it("keeps bets of another area apart from the missed-first rule", () => {
    const otherArea = bet({ id: "beta/B1", initiative: "beta", outcome: "beta/x", order: 1, state: "proposed" });
    const missed = bet({ id: "alpha/B1", order: 5, state: "done" });

    const ordered = orderBetsForSheet([{ bet: otherArea }, { bet: missed, check: "missed" }]);

    expect(ordered.map((entry) => entry.bet.id)).toEqual(["alpha/B1", "beta/B1"]);
  });

  it("orders confirmed and unread bets by their order field", () => {
    const first = bet({ id: "alpha/B1", order: 2 });
    const second = bet({ id: "alpha/B2", order: 1 });

    const ordered = orderBetsForSheet([{ bet: first, check: "confirmed" }, { bet: second, check: "unread" }]);

    expect(ordered.map((entry) => entry.bet.id)).toEqual(["alpha/B2", "alpha/B1"]);
  });
});
