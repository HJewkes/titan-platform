import { BetSchema, TaskSchema, type Bet, type Task } from "@titan-design/pm";
import { describe, expect, it } from "vitest";
import { stopRuleHolds, type SpendRead, type StopMarks, type StopSignals, type TaskRun } from "./stop-rules.js";

const RULES = { taskFixRounds: 3, spendMultiple: 2, usdPerPoint: 8, betStoppedPrs: 3, betFollowupMultiple: 2, checkpointEvery: 5 };

const NO_MARKS: StopMarks = { plannerLooked: new Set(), checkpoints: new Map() };

function task(n: number, fields: Record<string, unknown> = {}): Task {
  return TaskSchema.parse({ id: `AL-${n}`, title: `Synthetic ${n}`, priority: 1, status: "open", created: "2026-11-01", updated: "2026-11-09", done_at: null, ...fields });
}

function bet(tasks: number[]): Bet {
  const prediction = { metric: "lead time", direction: "decrease", baseline: 4, expected: 2, read_by: "2026-11-30" };
  return BetSchema.parse({ id: "alpha/B1", initiative: "alpha", week: "2026-W47", outcome: "alpha/faster-landing", order: 1, tasks: tasks.map((n) => `alpha/AL-${n}`), prediction, state: "selected" });
}

function run(n: number, fields: Partial<TaskRun> = {}): TaskRun {
  return { task: `alpha/AL-${n}`, pr: `acme/app#${n}`, createdAt: "2026-11-10T00:00:00Z", outcome: null, fixRounds: 0, ...fields };
}

interface Case {
  tasks?: Task[];
  runs?: TaskRun[];
  spend?: SpendRead;
  marks?: StopMarks;
  members?: number[];
}

/** Holds on AL-1, the one candidate, in a bet of `members` (AL-1 alone by default). */
function holdsFor({ tasks = [task(1)], runs = [], spend = { ok: true, usd: new Map() }, marks = NO_MARKS, members = [1] }: Case) {
  const signals: StopSignals = { tasks, runs, spend, marks };
  return stopRuleHolds({ initiative: "alpha", candidates: [{ task: tasks[0]!, bet: bet(members) }], signals, rules: RULES });
}

const codes = (c: Case): string[] => holdsFor(c).flatMap((hold) => hold.codes);

const merged = (count: number): TaskRun[] => Array.from({ length: count }, (_, at) => run(1, { pr: `acme/app#${at + 100}`, outcome: "merged" }));

describe("task-fix-cap", () => {
  it("2 fix rounds on the latest run admit, and 3 refuse with a planner looking once", () => {
    expect(codes({ runs: [run(1, { fixRounds: 2 })] })).toEqual([]);

    expect(holdsFor({ runs: [run(1, { fixRounds: 3 })] })).toEqual([
      { task: "alpha/AL-1", stage: "stop", codes: ["task-fix-cap"], details: [expect.stringContaining("3 fix rounds")], numbers: { fixRounds: 3, cap: 3 }, next: "planner-once" },
    ]);
  });

  it("parks the task once the planner has looked", () => {
    const marks = { ...NO_MARKS, plannerLooked: new Set(["alpha/AL-1"]) };

    expect(holdsFor({ runs: [run(1, { fixRounds: 3 })], marks })[0]?.next).toBe("park");
  });

  it("reads the task's latest run, not an older one that churned", () => {
    const runs = [run(1, { fixRounds: 4, createdAt: "2026-11-01T00:00:00Z" }), run(1, { pr: "acme/app#9", fixRounds: 1, createdAt: "2026-11-12T00:00:00Z" })];

    expect(codes({ runs })).toEqual([]);
  });
});

describe("task-spend-cap", () => {
  const spent = (usd: number | null): SpendRead => ({ ok: true, usd: new Map([["alpha/AL-1", usd]]) });

  it("spend at 2 x estimate x usd-per-point refuses, and a cent under admits", () => {
    expect(holdsFor({ tasks: [task(1, { estimate: 2 })], spend: spent(32) })[0]).toMatchObject({ codes: ["task-spend-cap"], numbers: { spendUsd: 32, capUsd: 32 } });
    expect(codes({ tasks: [task(1, { estimate: 2 })], spend: spent(31.99) })).toEqual([]);
  });

  it("unread spend does not hold, and is named on a row held for another reason", () => {
    const unread: SpendRead = { ok: false, why: "no ticket-scorecard store" };

    expect(codes({ tasks: [task(1, { estimate: 2 })], spend: unread })).toEqual([]);
    expect(codes({ tasks: [task(1, { estimate: 2 })], spend: spent(null) })).toEqual([]);
    const held = holdsFor({ tasks: [task(1, { estimate: 2 })], spend: unread, runs: [run(1, { fixRounds: 3 })] });
    expect(held[0]?.details).toContain("task-spend-cap unread: no ticket-scorecard store");
  });

  it("a task with no estimate has no spend cap", () => {
    expect(codes({ spend: spent(1000) })).toEqual([]);
  });
});

describe("bet-parked", () => {
  const stopped = (ns: number[]): TaskRun[] => ns.map((n) => run(n, { outcome: "stopped" }));

  it("3 bet tasks with a stopped PR park every candidate in the bet with the one owner question", () => {
    const tasks = [task(1), task(2), task(3), task(4)];
    const candidates = [tasks[0]!, tasks[3]!].map((entry) => ({ task: entry, bet: bet([1, 2, 3, 4]) }));
    const signals: StopSignals = { tasks, runs: stopped([1, 2, 3]), spend: { ok: true, usd: new Map() }, marks: NO_MARKS };

    const holds = stopRuleHolds({ initiative: "alpha", candidates, signals, rules: RULES });

    expect(holds.map((hold) => [hold.task, hold.codes, hold.would_ask, hold.numbers])).toEqual([
      ["alpha/AL-1", ["bet-parked"], true, { stoppedPrs: 3 }],
      ["alpha/AL-4", ["bet-parked"], true, { stoppedPrs: 3 }],
    ]);
  });

  it("2 stopped tasks, or 3 stopped runs of one task, admit", () => {
    expect(codes({ tasks: [task(1), task(2), task(3)], members: [1, 2, 3], runs: stopped([2, 3]) })).toEqual([]);
    expect(codes({ members: [1, 2], runs: [1, 2, 3].map((n) => run(2, { pr: `acme/app#${n}`, outcome: "stopped" })) })).toEqual([]);
  });
});

describe("bet-followups", () => {
  const followUp = (n: number, estimate: number, fromTask: string) => task(n, { estimate, source: "follow-up", source_ref: { from_pr: "acme/app#1", from_task: fromTask } });

  it("follow-ups estimated above 2 x the bet's own tasks hold, and exactly 2 x admits", () => {
    const own = [task(1, { estimate: 2 }), task(2, { estimate: 1 })];

    expect(holdsFor({ members: [1, 2], tasks: [...own, followUp(7, 4, "AL-1"), followUp(8, 3, "AL-2")] })[0]).toMatchObject({ codes: ["bet-followups"], numbers: { followupEstimate: 7, betEstimate: 3 } });
    expect(codes({ members: [1, 2], tasks: [...own, followUp(7, 6, "AL-1")] })).toEqual([]);
  });

  it("a follow-up of a task outside the bet, or a review finding, does not count", () => {
    const review = task(8, { estimate: 9, source: "review", source_ref: { from_pr: "acme/app#1", from_task: "AL-1" } });

    expect(codes({ tasks: [task(1, { estimate: 1 }), followUp(7, 9, "AL-5"), review] })).toEqual([]);
  });
});

describe("programme-checkpoint", () => {
  const at = (bet: string, counts: number[]): StopMarks => ({ ...NO_MARKS, checkpoints: new Map([[bet, new Set(counts)]]) });

  it("5 merged PRs with no checkpoint hold, and with one admit", () => {
    expect(holdsFor({ runs: merged(5) })[0]).toMatchObject({ codes: ["programme-checkpoint"], numbers: { mergedPrs: 5, checkpointEvery: 5 } });
    expect(codes({ runs: merged(5), marks: at("alpha/B1", [5]) })).toEqual([]);
  });

  it("6 admit, and 10 with only the 5 checkpoint hold", () => {
    expect(codes({ runs: merged(6) })).toEqual([]);
    expect(codes({ runs: merged(10), marks: at("alpha/B1", [5]) })).toEqual(["programme-checkpoint"]);
  });

  it("two runs of one merged PR count once", () => {
    expect(codes({ runs: [...merged(4), run(1, { pr: "acme/app#100", outcome: "merged" })] })).toEqual([]);
  });
});
