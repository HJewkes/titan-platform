import { describe, expect, it, vi } from "vitest";
import { FIXTURE_CORPUS, fixtureCandidate } from "./fixture.js";
import { estimateTokens, planContext } from "./plan.js";

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

describe("planContext deepening", () => {
  const tierOf = (plan: { entries: { id: string; tier: number }[] }, id: string): number | undefined =>
    plan.entries.find((e) => e.id === id)?.tier;

  it("places every candidate at tier 0 before deepening any", () => {
    const set = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4].map((score, i) => cand(`c${i}`, score, [4, 8, 12]));
    const plan = planContext(set, { tokens: 24 });
    expect(plan.entries).toHaveLength(6);
    expect(plan.entries.every((e) => e.tier === 0)).toBe(true);
  });

  it("spends leftover on the best hit first", () => {
    const plan = planContext([cand("b", 0.8, [4, 8]), cand("a", 0.9, [4, 8])], { tokens: 12 });
    expect(tierOf(plan, "a")).toBe(1);
    expect(tierOf(plan, "b")).toBe(0);
  });

  it("deepens one tier at a time and stops at the first tier that does not fit", () => {
    const reachesTwo = planContext([cand("x", 0.9, [4, 8, 12, 200])], { tokens: 30 });
    expect(tierOf(reachesTwo, "x")).toBe(2);
    const blocked = planContext([cand("y", 0.9, [4, 40, 8])], { tokens: 20 });
    expect(tierOf(blocked, "y")).toBe(0);
  });

  it("stops deepening at exactly twice the mean share", () => {
    const set = [cand("e1", 0.9, [2, 20, 24]), cand("e2", 0.8, [2]), cand("e3", 0.7, [2]), cand("e4", 0.6, [2])];
    const plan = planContext(set, { tokens: 40 });
    const e1 = plan.entries.find((e) => e.id === "e1");
    expect(e1?.tier).toBe(1);
    expect(e1?.tokens).toBe(20);
  });

  it("ignores quotas while deepening", () => {
    const set = [cand("n1", 0.9, [4, 16]), cand("t1", 0.8, [4], "tasks")];
    const plan = planContext(set, { tokens: 40, quotas: { notes: 0.25 } });
    const n1 = plan.entries.find((e) => e.id === "n1");
    expect(n1?.tier).toBe(1);
    expect(n1?.tokens).toBe(16);
  });

  it("never deepens past maxTier", () => {
    const set = [cand("a", 0.9, [4, 8, 12]), cand("b", 0.8, [4, 8, 12]), cand("c", 0.7, [4, 8, 12])];
    const capped = planContext(set, { tokens: 200, maxTier: 1 });
    expect(capped.entries.map((e) => e.tier)).toEqual([1, 1, 1]);
    const clamped = planContext([cand("a", 0.9, [4, 8, 12])], {
      tokens: 200,
      maxTier: 1,
      defaultTiers: { notes: 2 },
    });
    expect(tierOf(clamped, "a")).toBe(1);
  });

  it("uses the injected estimator for every cost", () => {
    const words = vi.fn((text: string) => text.split(" ").length);
    const set = [
      { id: "a", category: "notes", score: 0.9, tiers: ["one two", "one two three four five"] },
      { id: "b", category: "notes", score: 0.8, tiers: ["alpha", "alpha beta gamma"] },
    ];
    const plan = planContext(set, { tokens: 20, estimateTokens: words });
    expect(words).toHaveBeenCalled();
    for (const e of plan.entries) expect(e.tokens).toBe(e.text.split(" ").length);
    expect(plan.entries.map((e) => e.tier)).toEqual([1, 1]);
    expect(plan.usedTokens).toBe(8);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });

  it.each(Array.from({ length: 201 }, (_, tokens) => tokens))(
    "keeps usedTokens within budget after deepening at %i tokens",
    (tokens) => {
      const plan = planContext(FIXTURE_CORPUS, { tokens, quotas: { notes: 0.4, tasks: 0.4, sources: 0.4 } });
      expect(plan.usedTokens).toBeLessThanOrEqual(tokens);
      expect(plan.usedTokens).toBe(plan.entries.reduce((sum, e) => sum + e.tokens, 0));
    },
  );

  it("keeps the cap computed from the breadth count after an over-cap drop", () => {
    const set = [
      cand("s2", 0.9, [24], "sources"),
      cand("n1", 0.8, [2, 20, 25]),
      cand("n2", 0.7, [2]),
      cand("n3", 0.6, [2]),
    ];
    const plan = planContext(set, { tokens: 40 });
    expect(plan.dropped).toEqual([{ id: "s2", category: "sources", reason: "over-cap" }]);
    const n1 = plan.entries.find((e) => e.id === "n1");
    expect(n1?.tier).toBe(1);
    expect(n1?.tokens).toBe(20);
  });
});
