import { describe, expect, it } from "vitest";
import { FIXTURE_CORPUS, fixtureCandidate } from "./fixture.js";
import { planContext } from "./plan.js";

const ids = (plan: { entries: { id: string }[] }): string[] => plan.entries.map((e) => e.id);
const cand = (id: string, score: number, tiers: number[], category = "notes") =>
  fixtureCandidate(id, category, score, tiers);

describe("planContext", () => {
  it("drops a candidate that does not fit and keeps walking to a smaller later one", () => {
    const plan = planContext([cand("a", 0.9, [4]), cand("b", 0.8, [8]), cand("c", 0.7, [6])], { tokens: 10 });
    expect(ids(plan)).toEqual(["a", "c"]);
    expect(plan.usedTokens).toBe(10);
    expect(plan.dropped).toEqual([{ id: "b", category: "notes", reason: "over-budget" }]);
  });

  it("measures a category quota in tokens and drops past it as over-quota", () => {
    const plan = planContext(
      [cand("n1", 0.9, [6]), cand("n2", 0.8, [4]), cand("n3", 0.7, [2]), cand("t1", 0.6, [8], "tasks")],
      { tokens: 40, quotas: { notes: 0.25 } },
    );
    expect(ids(plan)).toEqual(["n1", "n2", "t1"]);
    expect(plan.dropped).toEqual([{ id: "n3", category: "notes", reason: "over-quota" }]);
  });

  it("gives a category with no quota entry the defaultQuota", () => {
    const set = [cand("t1", 0.9, [12], "tasks"), cand("t2", 0.8, [8], "tasks"), cand("t3", 0.7, [4], "tasks")];
    const limited = planContext(set, { tokens: 40, quotas: { notes: 0.25 }, defaultQuota: 0.5 });
    expect(limited.dropped).toEqual([{ id: "t3", category: "tasks", reason: "over-quota" }]);
    const open = planContext(set, { tokens: 40, quotas: { notes: 0.25 } });
    expect(ids(open)).toEqual(["t1", "t2", "t3"]);
  });

  it("fills the budget when quotas sum above 1 and one category is empty", () => {
    const set = [
      cand("t1", 0.9, [5], "tasks"),
      cand("t2", 0.8, [5], "tasks"),
      cand("s1", 0.7, [5], "sources"),
      cand("s2", 0.6, [5], "sources"),
    ];
    const plan = planContext(set, { tokens: 20, quotas: { notes: 0.5, tasks: 0.5, sources: 0.5 } });
    expect(plan.entries).toHaveLength(4);
    expect(plan.usedTokens).toBe(20);
  });

  it("falls back to the deepest lower tier under twice the mean share", () => {
    const set = [
      cand("s1", 0.9, [2, 6, 24], "sources"),
      cand("n1", 0.8, [4]),
      cand("n2", 0.7, [4]),
      cand("n3", 0.6, [4]),
    ];
    const plan = planContext(set, { tokens: 40, defaultTiers: { sources: 2 } });
    const s1 = plan.entries.find((e) => e.id === "s1");
    expect(s1?.tier).toBe(1);
    expect(s1?.tokens).toBe(6);
  });

  it("drops an entry whose cheapest tier exceeds the cap as over-cap", () => {
    const set = [cand("s2", 0.9, [24], "sources"), cand("n1", 0.8, [4]), cand("n2", 0.7, [4]), cand("n3", 0.6, [4])];
    const plan = planContext(set, { tokens: 40 });
    expect(plan.dropped).toEqual([{ id: "s2", category: "sources", reason: "over-cap" }]);
    expect(ids(plan)).toEqual(["n1", "n2", "n3"]);
    expect(plan.usedTokens).toBe(12);
  });

  it("places a duplicate id once, at its higher-scoring copy", () => {
    const plan = planContext(FIXTURE_CORPUS, { tokens: 200, maxTier: 0 });
    const copies = plan.entries.filter((e) => e.id === "ferry-0715");
    expect(copies.map((e) => e.category)).toEqual(["tasks"]);
    expect(plan.dropped).toContainEqual({ id: "ferry-0715", category: "sources", reason: "duplicate" });
  });

  it("lets a later copy place when the first copy was dropped over quota", () => {
    const plan = planContext([cand("dup", 0.9, [4], "tasks"), cand("dup", 0.5, [4], "sources")], {
      tokens: 20,
      quotas: { tasks: 0.1 },
    });
    expect(plan.entries.map((e) => [e.id, e.category])).toEqual([["dup", "sources"]]);
    expect(plan.dropped).toEqual([{ id: "dup", category: "tasks", reason: "over-quota" }]);
  });

  it("keeps input order for equal scores and sorts unsorted input", () => {
    const plan = planContext([cand("low", 0.1, [1]), cand("zeta", 0.5, [1]), cand("alpha", 0.5, [1])], {
      tokens: 10,
    });
    expect(ids(plan)).toEqual(["zeta", "alpha", "low"]);
  });

  it.each(Array.from({ length: 201 }, (_, tokens) => tokens))(
    "never spends more than the budget at %i tokens",
    (tokens) => {
      const plan = planContext(FIXTURE_CORPUS, {
        tokens,
        maxTier: 0,
        quotas: { notes: 0.4, tasks: 0.4, sources: 0.4 },
      });
      expect(plan.usedTokens).toBeLessThanOrEqual(tokens);
      expect(plan.usedTokens).toBe(plan.entries.reduce((sum, e) => sum + e.tokens, 0));
      if (tokens === 0) {
        expect(plan.entries).toEqual([]);
        expect(plan.dropped.every((d) => d.reason === "over-budget")).toBe(true);
      }
    },
  );

  it("drops a candidate with no tiers and rejects an invalid budget", () => {
    const blank = { id: "blank", category: "notes", score: 0.9, tiers: [] };
    const plan = planContext([blank], { tokens: 10 });
    expect(plan.dropped).toEqual([{ id: "blank", category: "notes", reason: "no-tiers" }]);
    for (const tokens of [-1, 1.5, Number.NaN]) {
      expect(() => planContext([], { tokens })).toThrow(RangeError);
    }
  });
});
