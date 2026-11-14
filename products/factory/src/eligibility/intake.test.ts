import type { Bet, Outcome, Task } from "@titan-design/pm";
import { describe, expect, it } from "vitest";
import type { SelectionPolicy } from "./intake.js";
import { evaluateEligibility, type PlanView } from "./rules.js";

const prediction = { metric: "lead time", direction: "decrease" as const, baseline: 4, expected: 2, read_by: "2026-11-30" };

const bet: Bet = { id: "alpha/B1", initiative: "alpha", week: "2026-W47", outcome: "alpha/faster-landing", order: 1, prediction, state: "selected", tasks: ["alpha/AL-1"] };

function task(fields: Partial<Task> = {}): Task {
  const base = { id: "AL-1", title: "Synthetic", priority: 1, status: "open" as const, created: "2026-11-10", updated: "2026-11-10", done_at: null };
  return { ...base, done_when: "A test shows it.", bet: "alpha/B1", fold: "independent", owner_steps: [], ...fields };
}

const outcome = (state: Outcome["state"]): Outcome => ({ id: "alpha/faster-landing", initiative: "alpha", statement: "Land faster", measure: "lead time", state });

const plan = (fields: Partial<PlanView> = {}): PlanView => ({ initiative: "alpha", bets: [bet], freezes: [], outOfScope: [], outcomes: [outcome("active")], ...fields });

function policy(fields: Partial<SelectionPolicy> = {}): SelectionPolicy {
  return { relax: [], intake: { minSeverity: "medium", expireDays: 28 }, today: "2026-11-18", stoppedPrs: new Set(), ...fields };
}

const fromPr = { from_pr: "acme/widgets#12", from_task: "AL-9" };

function codes(t: Task, p: SelectionPolicy = policy(), view: PlanView = plan()): string[] {
  const result = evaluateEligibility([t], view, p);
  return result.refused[0]?.refusals.map((refusal) => refusal.code) ?? [];
}

describe("selection policy refusals", () => {
  it("an agent-filed task below medium severity, or with none, is refused as intake-low-severity", () => {
    expect(codes(task({ source: "sweep", severity: "low" }))).toEqual(["intake-low-severity"]);
    expect(codes(task({ source: "audit" }))).toEqual(["intake-low-severity"]);
  });

  it("an agent-filed task at exactly the minimum severity passes", () => {
    expect(codes(task({ source: "sweep", severity: "medium" }))).toEqual([]);
  });

  it("a task filed from a PR whose Shepherd run stopped is refused as intake-from-stopped-pr", () => {
    const followUp = task({ source: "follow-up", severity: "high", source_ref: fromPr });

    expect(codes(followUp, policy({ stoppedPrs: new Set(["acme/widgets#12"]) }))).toEqual(["intake-from-stopped-pr"]);
    expect(codes(followUp, policy({ stoppedPrs: new Set(["acme/widgets#13"]) }))).toEqual([]);
  });

  it("an unread Shepherd fails closed for a task citing a PR, as signal-unreadable", () => {
    expect(codes(task({ source: "review", severity: "high", source_ref: fromPr }), policy({ stoppedPrs: "unread" }))).toEqual(["signal-unreadable"]);
  });

  it("an agent-filed task promoted into no bet expires past expireDays, and not on the last day", () => {
    const stale = task({ id: "AL-2", source: "sweep", severity: "high", bet: undefined, created: "2026-10-20" });
    const lastDay = task({ id: "AL-2", source: "sweep", severity: "high", bet: undefined, created: "2026-10-21" });

    expect(codes(stale)).toEqual(["no-bet", "intake-expired"]);
    expect(codes(lastDay)).toEqual(["no-bet"]);
  });

  it("an incident is never refused by intake, whatever its severity, age or origin", () => {
    const incident = task({ id: "AL-2", source: "incident", bet: undefined, created: "2026-01-01" });

    expect(codes(incident)).toEqual(["no-bet"]);
  });

  it("a task serving another outcome than its bet's is refused as serves-other-outcome", () => {
    expect(codes(task({ serves: "alpha/other-outcome" }))).toEqual(["serves-other-outcome"]);
    expect(codes(task({ serves: "alpha/faster-landing" }))).toEqual([]);
  });

  it("a task under a bet whose outcome is retired is refused as outcome-retired", () => {
    expect(codes(task(), policy(), plan({ outcomes: [outcome("retired")] }))).toEqual(["outcome-retired"]);
  });

  it("a task with blocked_on set is refused as blocked", () => {
    expect(codes(task({ blocked_on: "decision" }))).toEqual(["blocked"]);
  });
});

describe("the relax list", () => {
  it("bet-field admits a task its bet lists without task.bet, keeping the strict no-bet verdict", () => {
    const result = evaluateEligibility([task({ bet: undefined })], plan(), policy({ relax: ["bet-field"] }));

    expect(result.eligible.map((entry) => [entry.task.id, entry.bet.id, entry.relaxed, entry.strictCodes])).toEqual([["AL-1", "alpha/B1", ["bet-field"], ["no-bet"]]]);
  });

  it("bet-field still refuses a task no selected bet lists", () => {
    expect(codes(task({ id: "AL-2", bet: undefined }), policy({ relax: ["bet-field"] }))).toEqual(["no-bet"]);
  });

  it("no-fold and no-owner-steps waive only their own checks, and list only the waivers used", () => {
    const result = evaluateEligibility([task({ fold: undefined })], plan(), policy({ relax: ["no-fold", "no-owner-steps"] }));

    expect(result.eligible.map((entry) => [entry.relaxed, entry.strictCodes])).toEqual([[["no-fold"], ["no-fold"]]]);
    expect(codes(task({ done_when: undefined, fold: undefined }), policy({ relax: ["no-fold"] }))).toEqual(["no-done-when"]);
  });

  it("a strict pass carries no relaxed label", () => {
    const result = evaluateEligibility([task()], plan(), policy({ relax: ["bet-field", "no-fold", "no-owner-steps"] }));

    expect(result.eligible[0]).not.toHaveProperty("relaxed");
  });
});
