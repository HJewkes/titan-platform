import type { Bet, Freeze, Task } from "@titan-design/pm";
import { describe, expect, it } from "vitest";
import { evaluateEligibility, type PlanView } from "./rules.js";

function bet(n: number, order: number, tasks?: string[]): Bet {
  const prediction = { metric: "lead time", direction: "decrease" as const, baseline: 4, expected: 2, read_by: "2026-11-30" };
  return { id: `alpha/B${n}`, initiative: "alpha", week: "2026-W47", outcome: "alpha/faster-landing", order, prediction, state: "selected", ...(tasks ? { tasks } : { selector: "area:x" }) };
}

function task(n: number, fields: Partial<Task> = {}): Task {
  return {
    id: `AL-${n}`,
    title: `Synthetic task ${n}`,
    priority: 1,
    status: "open",
    created: "2026-11-01",
    updated: "2026-11-01",
    done_at: null,
    done_when: "A test shows the thing.",
    bet: "alpha/B1",
    fold: "independent",
    owner_steps: [],
    ...fields,
  };
}

function freeze(fields: Partial<Freeze>): Freeze {
  const base = { id: "alpha/F1", initiative: "alpha", reason: "Hold the area", end_condition: { kind: "owner" as const }, set_by: "owner" as const, intent_ref: "D1", quote_ref: "msg:1" };
  return { ...base, tag: "frozen-area", ...fields };
}

function plan(fields: Partial<PlanView> = {}): PlanView {
  return { initiative: "alpha", bets: [bet(1, 1, ["alpha/AL-1", "alpha/AL-2", "alpha/AL-3"])], freezes: [], outOfScope: [], ...fields };
}

const codesOf = (result: ReturnType<typeof evaluateEligibility>, id: string) =>
  result.refused.find((refused) => refused.id === id)?.refusals.map((refusal) => refusal.code);

describe("dispatch eligibility rules", () => {
  it("a task that meets every rule under a selected bet that lists it is eligible", () => {
    const result = evaluateEligibility([task(1)], plan());

    expect(result.refused).toEqual([]);
    expect(result.eligible.map((entry) => [entry.task.id, entry.bet.id])).toEqual([["AL-1", "alpha/B1"]]);
  });

  it("a task without a bet is refused with no-bet", () => {
    const result = evaluateEligibility([task(1, { bet: undefined })], plan());

    expect(codesOf(result, "AL-1")).toEqual(["no-bet"]);
  });

  it("a task naming a bet that is not selected this week is refused with bet-not-selected", () => {
    const result = evaluateEligibility([task(1, { bet: "alpha/B9" })], plan());

    expect(codesOf(result, "AL-1")).toEqual(["bet-not-selected"]);
  });

  it("a task whose selected bet does not list it is refused with not-in-bet", () => {
    const result = evaluateEligibility([task(4)], plan());

    expect(codesOf(result, "AL-4")).toEqual(["not-in-bet"]);
  });

  it("a bet that names its tasks only by selector approves none of them", () => {
    const result = evaluateEligibility([task(1)], plan({ bets: [bet(1, 1)] }));

    expect(codesOf(result, "AL-1")).toEqual(["not-in-bet"]);
  });

  it("a task without done_when, or with a blank one, is refused with no-done-when", () => {
    const result = evaluateEligibility([task(1, { done_when: undefined }), task(2, { done_when: "  " })], plan());

    expect(codesOf(result, "AL-1")).toEqual(["no-done-when"]);
    expect(codesOf(result, "AL-2")).toEqual(["no-done-when"]);
  });

  it("absent owner_steps and an unset fold are refused, while an empty owner_steps list passes", () => {
    const result = evaluateEligibility([task(1, { owner_steps: undefined, fold: undefined }), task(2, { owner_steps: [] })], plan());

    expect(codesOf(result, "AL-1")).toEqual(["no-owner-steps", "no-fold"]);
    expect(result.eligible.map((entry) => entry.task.id)).toEqual(["AL-2"]);
  });

  it("a task carrying an active freeze's tag is refused with frozen, and an untagged one is not", () => {
    const result = evaluateEligibility([task(1, { tags: ["frozen-area"] }), task(2, { tags: ["other"] })], plan({ freezes: [freeze({})] }));

    expect(codesOf(result, "AL-1")).toEqual(["frozen"]);
    expect(result.eligible.map((entry) => entry.task.id)).toEqual(["AL-2"]);
  });

  it("a freeze named by selector covers every task, so it fails closed", () => {
    const result = evaluateEligibility([task(1)], plan({ freezes: [freeze({ tag: undefined, selector: "area:x" })] }));

    expect(codesOf(result, "AL-1")).toEqual(["frozen"]);
  });

  it("a task tagged with an out-of-scope record's id is refused with out-of-scope", () => {
    const record = { id: "alpha/X1", initiative: "alpha", statement: "No mobile app", intent_ref: "D2", quote_ref: "msg:2", date: "2026-11-01" };

    const result = evaluateEligibility([task(1, { tags: ["alpha/X1"] })], plan({ outOfScope: [record] }));

    expect(codesOf(result, "AL-1")).toEqual(["out-of-scope"]);
  });

  it("one task carries every reason it fails, in rule order", () => {
    const bare = task(1, { bet: undefined, done_when: undefined, owner_steps: undefined, fold: undefined, tags: ["frozen-area"] });

    const result = evaluateEligibility([bare], plan({ freezes: [freeze({})] }));

    expect(codesOf(result, "AL-1")).toEqual(["no-bet", "no-done-when", "no-owner-steps", "no-fold", "frozen"]);
  });

  it("eligible tasks follow the owner's bet order, then product before upkeep, then oldest first", () => {
    const bets = [bet(2, 1, ["alpha/AL-5"]), bet(1, 2, ["alpha/AL-1", "alpha/AL-2", "alpha/AL-3", "alpha/AL-4"])];
    const tasks = [
      task(1, { class: "upkeep", created: "2026-10-01" }),
      task(2, { class: "product", created: "2026-11-05" }),
      task(3, { class: "product", created: "2026-11-02T09:00:00Z" }),
      task(4, { created: "2026-09-01" }),
      task(5, { bet: "alpha/B2", class: "upkeep", created: "2026-11-10" }),
    ];

    const result = evaluateEligibility(tasks, plan({ bets }));

    expect(result.eligible.map((entry) => entry.task.id)).toEqual(["AL-5", "AL-3", "AL-2", "AL-1", "AL-4"]);
  });
});
