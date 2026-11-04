import { describe, expect, it } from "vitest";
import { pickCandidate } from "./audition-score.js";

describe("audition pick", () => {
  it("picks the highest total and names the runner-up with the margin", () => {
    const result = pickCandidate([{ id: "c1", total: 0.7, likelihood: 0.5 }, { id: "c2", total: 0.82, likelihood: 0.2 }, { id: "c3", total: 0.75, likelihood: 0.3 }]);

    expect(result).toEqual({ pick: { id: "c2", total: 0.82, likelihood: 0.2 }, runnerUp: { id: "c3", total: 0.75, likelihood: 0.3 }, margin: 0.07 });
  });

  it("a tie goes to the higher stated likelihood, then the earlier slot", () => {
    expect(pickCandidate([{ id: "c1", total: 0.8, likelihood: 0.2 }, { id: "c2", total: 0.8, likelihood: 0.5 }]).pick.id).toBe("c2");
    expect(pickCandidate([{ id: "c1", total: 0.8, likelihood: 0.3 }, { id: "c2", total: 0.8, likelihood: 0.3 }])).toMatchObject({ pick: { id: "c1" }, runnerUp: { id: "c2" }, margin: 0 });
  });

  it("refuses to pick from fewer than two scored candidates", () => {
    expect(() => pickCandidate([{ id: "c1", total: 1, likelihood: 1 }])).toThrow(/at least 2/);
  });
});
