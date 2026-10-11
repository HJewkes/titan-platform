import { describe, expect, it } from "vitest";
import { DEFAULT_CLASS_ROLES, DEFAULT_PANEL_POLICY, DEFAULT_PANEL_TABLE, planPanel } from "./plan.js";
import type { PanelPolicy } from "./plan.js";
import type { PrClass, PrTouch, ReviewClass } from "./types.js";

const cls = (klass: ReviewClass, touches: PrTouch[] = []): PrClass => ({ class: klass, touches });
const OPUS = { opus: true };
const NO_OPUS = { opus: false };
const PANEL: PanelPolicy = { ...DEFAULT_PANEL_POLICY, panel: DEFAULT_PANEL_TABLE };

const summary = (klass: ReviewClass, touches: PrTouch[] = [], policy = PANEL, headroom = OPUS) =>
  planPanel(cls(klass, touches), policy, headroom).members.map((m) => `${m.shape}:${m.profile}:${m.blocking ? "blocking" : "advisory"}`);

describe("planPanel with no panel table (TP-1428)", () => {
  it("plans only the correctness member, at today's g10 and standard profiles", () => {
    expect(summary("g10", ["authority", "untested", "large"], DEFAULT_PANEL_POLICY)).toEqual(["correctness:bd-reviewer:blocking"]);
    expect(summary("standard", ["visual", "untested"], DEFAULT_PANEL_POLICY)).toEqual(["correctness:reviewer:blocking"]);
  });

  it("uses the configured class roles for the correctness member", () => {
    const policy: PanelPolicy = { roles: { g10: "strict-reviewer", standard: "plain-reviewer" } };
    expect(summary("g10", [], policy)).toEqual(["correctness:strict-reviewer:blocking"]);
    expect(summary("standard", [], policy)).toEqual(["correctness:plain-reviewer:blocking"]);
  });

  it("keeps TP-1428's default roles", () => {
    expect(DEFAULT_CLASS_ROLES).toEqual({ g10: "bd-reviewer", standard: "reviewer" });
  });
});

describe("planPanel class table", () => {
  it("standard with no touches: correctness", () => {
    expect(summary("standard")).toEqual(["correctness:reviewer:blocking"]);
  });

  it("standard with a source change and no test change: correctness, tests", () => {
    expect(summary("standard", ["untested"])).toEqual(["correctness:reviewer:blocking", "tests:reviewer:advisory"]);
  });

  it("standard with a visual touch: correctness, visual", () => {
    expect(summary("standard", ["visual"])).toEqual(["correctness:reviewer:blocking", "visual:reviewer:advisory"]);
  });

  it("g10 with an authority, policy, security or migration touch: opus correctness, adversary", () => {
    for (const touch of ["authority", "policy", "security", "migration"] as const) {
      expect(summary("g10", [touch])).toEqual(["correctness:bd-reviewer:blocking", "adversary:reviewer:blocking"]);
    }
  });

  it("g10 that is large or on a hot path: opus correctness, adversary, perf", () => {
    expect(summary("g10", ["policy", "large"])).toEqual(["correctness:bd-reviewer:blocking", "adversary:reviewer:blocking", "perf:reviewer:advisory"]);
    expect(summary("g10", ["security", "perf"])).toEqual(["correctness:bd-reviewer:blocking", "adversary:reviewer:blocking", "perf:reviewer:advisory"]);
  });

  it("g10 with a source change and no test change: opus correctness, adversary, tests", () => {
    expect(summary("g10", ["authority", "untested"])).toEqual(["correctness:bd-reviewer:blocking", "adversary:reviewer:blocking", "tests:reviewer:advisory"]);
  });

  it("gives every member its shape's brief id", () => {
    const plan = planPanel(cls("g10", ["authority", "untested"]), PANEL, OPUS);
    expect(plan.members.map((m) => m.briefId)).toEqual(["correctness", "adversary", "tests"]);
  });
});

describe("planPanel caps", () => {
  it("never plans more than 3 members, keeping the table's order", () => {
    const plan = planPanel(cls("g10", ["authority", "untested", "large", "perf"]), PANEL, OPUS);
    expect(plan.members.map((m) => m.shape)).toEqual(["correctness", "adversary", "tests"]);
  });

  it("plans at most 1 opus member and lowers the rest to their sonnet profile without marking them degraded", () => {
    const policy: PanelPolicy = { ...PANEL, shapeRoles: { adversary: { g10: "bd-reviewer", standard: "bd-reviewer" } } };
    const plan = planPanel(cls("g10", ["authority"]), policy, OPUS);
    expect(plan.members.map((m) => [m.shape, m.profile, m.degraded])).toEqual([
      ["correctness", "bd-reviewer", false],
      ["adversary", "reviewer", false],
    ]);
    expect(plan.degraded).toBe(false);
  });

  it("lets a later member take the one opus seat when correctness is sonnet", () => {
    const policy: PanelPolicy = { ...PANEL, shapeRoles: { tests: { g10: "bd-reviewer", standard: "bd-reviewer" } } };
    expect(summary("standard", ["untested"], policy)).toEqual(["correctness:reviewer:blocking", "tests:bd-reviewer:advisory"]);
  });
});

describe("planPanel when headroom refuses opus", () => {
  it("plans the opus member at its sonnet profile, marked degraded", () => {
    const plan = planPanel(cls("g10", ["authority"]), PANEL, NO_OPUS);
    expect(plan.members[0]).toMatchObject({ shape: "correctness", profile: "reviewer", degraded: true, blocking: true });
    expect(plan.members[1]).toMatchObject({ shape: "adversary", degraded: false });
    expect(plan.degraded).toBe(true);
  });

  it("degrades the correctness member with no panel table too", () => {
    const plan = planPanel(cls("g10"), DEFAULT_PANEL_POLICY, NO_OPUS);
    expect(plan.members).toEqual([{ shape: "correctness", profile: "reviewer", briefId: "correctness", blocking: true, degraded: true }]);
  });

  it("leaves a sonnet-only plan untouched", () => {
    const plan = planPanel(cls("standard", ["visual"]), PANEL, NO_OPUS);
    expect(plan.degraded).toBe(false);
    expect(plan.members.every((m) => !m.degraded)).toBe(true);
  });
});

describe("planPanel spend estimate", () => {
  it("sums the points of each member's planned model", () => {
    const policy: PanelPolicy = { ...PANEL, points: { opus: 5, sonnet: 2 } };
    expect(planPanel(cls("g10", ["authority", "large"]), policy, OPUS).spendEstimate).toBe(5 + 2 + 2);
    expect(planPanel(cls("g10", ["authority", "large"]), policy, NO_OPUS).spendEstimate).toBe(2 + 2 + 2);
  });

  it("drops no member on cost, however high the estimate", () => {
    const policy: PanelPolicy = { ...PANEL, points: { opus: 1_000_000, sonnet: 1_000_000 } };
    const plan = planPanel(cls("g10", ["authority", "untested"]), policy, OPUS);
    expect(plan.members).toHaveLength(3);
    expect(plan.spendEstimate).toBe(3_000_000);
  });
});

describe("planPanel", () => {
  it("carries the class it planned for", () => {
    const pr = cls("standard", ["visual"]);
    expect(planPanel(pr, PANEL, OPUS).class).toBe(pr);
  });
});
