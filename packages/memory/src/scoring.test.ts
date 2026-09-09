import { describe, expect, it } from "vitest";
import { decayedCounts, decayedValue, effectiveScore, isStale, maturityFor, nextMaturity } from "./scoring.js";
import type { FeedbackEvent } from "./types.js";

const NOW = new Date("2026-09-08T12:00:00Z");

function event(type: FeedbackEvent["type"], daysAgo: number): FeedbackEvent {
  return { id: 0, bulletId: "b", type, at: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(), sessionRef: null, reason: null };
}

describe("decay", () => {
  it("halves an event's weight every half-life", () => {
    expect(decayedValue(event("helpful", 0).at, NOW)).toBeCloseTo(1);
    expect(decayedValue(event("helpful", 90).at, NOW)).toBeCloseTo(0.5);
    expect(decayedValue(event("helpful", 180).at, NOW)).toBeCloseTo(0.25);
  });

  it("honours a per-bullet half-life", () => {
    expect(decayedValue(event("helpful", 30).at, NOW, 30)).toBeCloseTo(0.5);
  });

  it("does not weight a future-dated event above one", () => {
    expect(decayedValue(event("helpful", -10).at, NOW)).toBe(1);
  });

  it("sums helpful and harmful mass separately", () => {
    const counts = decayedCounts([event("helpful", 0), event("helpful", 90), event("harmful", 0)], NOW);
    expect(counts.helpful).toBeCloseTo(1.5);
    expect(counts.harmful).toBeCloseTo(1);
  });
});

describe("effectiveScore", () => {
  it("weights harm four times and scales by maturity", () => {
    expect(effectiveScore({ helpful: 6, harmful: 1 }, "established")).toBe(2);
    expect(effectiveScore({ helpful: 6, harmful: 1 }, "proven")).toBe(3);
    expect(effectiveScore({ helpful: 6, harmful: 1 }, "candidate")).toBe(1);
    expect(effectiveScore({ helpful: 6, harmful: 1 }, "deprecated")).toBe(0);
  });
});

describe("maturityFor", () => {
  it("stays a candidate under three events", () => {
    expect(maturityFor({ helpful: 2, harmful: 0 })).toBe("candidate");
  });

  it("deprecates when more than thirty percent of the mass is harmful", () => {
    expect(maturityFor({ helpful: 2, harmful: 1 })).toBe("deprecated");
  });

  it("proves at ten helpful with under ten percent harm", () => {
    expect(maturityFor({ helpful: 10, harmful: 0 })).toBe("proven");
    expect(maturityFor({ helpful: 10, harmful: 2 })).toBe("established");
  });
});

describe("nextMaturity", () => {
  it("promotes straight to the earned rung", () => {
    expect(nextMaturity("candidate", { helpful: 12, harmful: 0 }, false)).toBe("proven");
  });

  it("demotes one rung at a time", () => {
    expect(nextMaturity("proven", { helpful: 1, harmful: 0 }, false)).toBe("established");
    expect(nextMaturity("established", { helpful: 1, harmful: 0 }, false)).toBe("candidate");
  });

  it("hard-deprecates below the floor regardless of rung", () => {
    expect(nextMaturity("proven", { helpful: 0, harmful: 3 }, false)).toBe("deprecated");
  });

  it("never moves a pinned bullet", () => {
    expect(nextMaturity("candidate", { helpful: 0, harmful: 9 }, true)).toBe("candidate");
  });

  it("leaves deprecated alone", () => {
    expect(nextMaturity("deprecated", { helpful: 20, harmful: 0 }, false)).toBe("deprecated");
  });
});

describe("isStale", () => {
  it("flags silence past the window, not low scores", () => {
    expect(isStale(event("helpful", 181).at, NOW)).toBe(true);
    expect(isStale(event("helpful", 179).at, NOW)).toBe(false);
    expect(isStale(event("helpful", 40).at, NOW, { staleAfterDays: 30 })).toBe(true);
  });
});
