import { describe, expect, it } from "vitest";
import type { ArLadder } from "../../server/autoresearch-view.js";
import { AR_RUN_FIXTURE } from "../../server/twin/autoresearch.js";
import { currentStage, implementerRoute, stageOfStep, stageSpans } from "./autoresearch-lanes.js";

const NOW = Date.parse("2031-03-05T12:00:30.000Z");
const MINUTE = 60_000;
const ago = (minutes: number): string => new Date(NOW - minutes * MINUTE).toISOString();
const ID = "i-0a1b2c3d4e5f";
const fixtureLadder = AR_RUN_FIXTURE.rounds[0]!.ladders[0]!;

function ladder(steps: readonly [string, number][], overrides: Partial<ArLadder> = {}): ArLadder {
  return {
    ...fixtureLadder, implementer: null, active: null, implementUsd: null, l0: null, micro: null, evals: [], outcome: null,
    completed: steps.map(([step, minutesAgo]) => ({ stepId: `ar-${step}:4/${ID}`, completedAt: ago(minutesAgo) })),
    ...overrides,
  };
}

const live = (stepId: string, startedMinutesAgo: number, restarts = 0) => ({ active: { stepId: `${stepId}:4/${ID}`, firstStartedAt: ago(startedMinutesAgo), restarts } });

describe("the lanes board's stage of a step", () => {
  it("places the seed eval in L2 and every later eval in L3, by key or by order", () => {
    expect(stageOfStep(`ar-eval:4/${ID}:r1`, 0)).toBe("l2");
    expect(stageOfStep(`ar-eval:4/${ID}:c1`, 3)).toBe("l3");
    expect(stageOfStep(`ar-eval:4/${ID}`, 0)).toBe("l2");
    expect(stageOfStep(`ar-eval:4/${ID}`, 1)).toBe("l3");
  });

  it("puts a ladder in the column of its live step, the next one between steps, and Done once decided", () => {
    expect(currentStage(ladder([], live("ar-alloc", 1)))).toBe("picked");
    expect(currentStage(ladder([["alloc", 9]], live("ar-implement", 8)))).toBe("implementing");
    expect(currentStage(ladder([["alloc", 9], ["implement", 4]], live("ar-l0", 3)))).toBe("l0");
    expect(currentStage(ladder([["alloc", 9], ["implement", 4], ["l0", 3]], live("ar-l1", 2)))).toBe("l1");
    expect(currentStage(ladder([["alloc", 9], ["implement", 4], ["l0", 3], ["l1", 2]]))).toBe("l2");
    expect(currentStage(ladder([["alloc", 9], ["implement", 4], ["l0", 3], ["l1", 2], ["eval", 1]], live("ar-eval", 1)))).toBe("l3");
    expect(currentStage(ladder([["alloc", 9]], { outcome: { verdict: "rejected", reason: "rejected:post:unit", rungReached: "L0" } }))).toBe("done");
  });
});

describe("the stage times on a card", () => {
  it("runs a live stage's timer from firstStartedAt, not from the previous stage's end, after a restart", () => {
    const evaluating = ladder([["alloc", 30], ["implement", 25], ["l0", 22], ["l1", 20]], live("ar-eval", 11, 1));

    const l2 = stageSpans(evaluating, NOW).find((span) => span.key === "l2")!;

    expect(l2).toMatchObject({ state: "active", durationMs: 11 * MINUTE });
  });

  it("times a finished stage from the previous stage's end and marks the stage a rejected idea stopped at", () => {
    const stopped = ladder([["alloc", 30], ["implement", 18], ["l0", 15], ["release", 14]], {
      implementUsd: 0.8, outcome: { verdict: "rejected", reason: "rejected:post:unit", rungReached: "L0" },
    });

    const spans = stageSpans(stopped, NOW);

    expect(spans.find((span) => span.key === "implementing")).toMatchObject({ state: "completed", durationMs: 12 * MINUTE, usd: 0.8 });
    expect(spans.find((span) => span.key === "l0")).toMatchObject({ state: "error", durationMs: 3 * MINUTE });
    expect(spans.find((span) => span.key === "l1")?.state).toBe("upcoming");
  });
});

describe("the implementer link", () => {
  it("opens the session log when the run names a session", () => {
    expect(implementerRoute({ agent: "ar-impl-x", sessionId: "s-0001" })).toEqual({ view: "sessions", id: "s-0001" });
  });

  it("falls back to the agent's page when the run names no session", () => {
    expect(implementerRoute({ agent: "ar-impl-x" })).toEqual({ view: "agents", id: "ar-impl-x" });
  });

  it("names nothing when the run has not recorded the implementer", () => {
    expect(implementerRoute(null)).toBeUndefined();
  });
});
