import { describe, expect, it } from "vitest";
import { loadBeatSpecs } from "./beat-load.js";
import { loadProfiles, profileFor } from "./profile-load.js";
import { beatBudget, blockBudgets, budgetVerdict } from "./resolve-budget.js";
import { wordsLong } from "./resolve-fixtures.test-helpers.js";

const specs = loadBeatSpecs();
const tour = profileFor(loadProfiles(), "repo-tour");

describe("word budget", () => {
  it("fails a 30-word beat in a 5 s slot", () => {
    const budget = beatBudget({ id: "b1", spoken: wordsLong(30), plannedS: 5 }, "story");

    expect(budget).toEqual({ scope: "beat", id: "b1", words: 30, seconds: 5, wordsPerS: 3.2, cap: 16 });
    expect(budgetVerdict([budget])).toEqual({ pass: false, detail: "1 of 1 word budgets over: beat b1 30 words > 16 (5 s at 3.2 w/s)" });
  });

  it("caps each beat type at its own band rate: 25 words in 10 s fit a concept beat but not a code beat", () => {
    const beat = { id: "b1", spoken: wordsLong(25), plannedS: 10 };

    expect(budgetVerdict([beatBudget(beat, "concept")]).pass).toBe(true);
    expect(budgetVerdict([beatBudget(beat, "code")]).pass).toBe(false);
    expect(beatBudget(beat, "takeaways").cap).toBe(28);
    expect(beatBudget(beat, "held").cap).toBe(15);
  });

  it("passes a beat at exactly its cap and fails one word over", () => {
    expect(budgetVerdict([beatBudget({ id: "b1", spoken: wordsLong(23), plannedS: 10 }, "code")]).pass).toBe(true);
    expect(budgetVerdict([beatBudget({ id: "b1", spoken: wordsLong(24), plannedS: 10 }, "code")]).pass).toBe(false);
  });

  it("caps a profile block at its longest airtime, at the fastest rate its beat types allow", () => {
    // repo-tour's cold-open runs at most 40 s and allows hook (story, 3.2 w/s): 128 words.
    const beats = [{ chapter: "cold-open", spoken: wordsLong(70) }, { chapter: "cold-open", spoken: wordsLong(60) }, { chapter: "purpose", spoken: wordsLong(10) }];

    const { rows, unplaced } = blockBudgets(beats, tour, specs);

    expect(rows).toEqual([
      { scope: "block", id: "cold-open", words: 130, seconds: 40, wordsPerS: 3.2, cap: 128 },
      { scope: "block", id: "purpose", words: 10, seconds: 75, wordsPerS: 2.8, cap: 210 },
    ]);
    expect(budgetVerdict(rows).pass).toBe(false);
    expect(unplaced).toEqual([]);
  });

  it("lists the chapters that name no profile block instead of capping them", () => {
    const { rows, unplaced } = blockBudgets([{ chapter: "ch1", spoken: wordsLong(500) }], tour, specs);

    expect(rows).toEqual([]);
    expect(unplaced).toEqual(["ch1"]);
  });
});
