import { describe, expect, it } from "vitest";
import { fixtureCandidate } from "./fixture.js";
import { planContext } from "./plan.js";

const ranked = (count: number) =>
  Array.from({ length: count }, (_, i) => fixtureCandidate(`r${i + 1}`, "notes", 1 - i / 10, [2]));
const ids = (plan: { entries: { id: string }[] }): string[] => plan.entries.map((e) => e.id);

describe("planContext entry order", () => {
  it("alternates five entries between the front and back so the ranks read 1,3,5,4,2", () => {
    const plan = planContext(ranked(5), { tokens: 100, order: "edges" });
    expect(ids(plan)).toEqual(["r1", "r3", "r5", "r4", "r2"]);
  });

  it("keeps score order when no order is given", () => {
    expect(ids(planContext(ranked(5), { tokens: 100 }))).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(ids(planContext(ranked(5), { tokens: 100, order: "score" }))).toEqual(["r1", "r2", "r3", "r4", "r5"]);
  });

  it("leaves one entry alone and puts rank 2 last for two entries", () => {
    expect(ids(planContext(ranked(1), { tokens: 100, order: "edges" }))).toEqual(["r1"]);
    expect(ids(planContext(ranked(2), { tokens: 100, order: "edges" }))).toEqual(["r1", "r2"]);
  });
});
