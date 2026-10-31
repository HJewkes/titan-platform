import { describe, expect, it } from "vitest";
import { MAIN_CI_READS, MAIN_CI_ROUTES, MERGEABLE_STATES, REVIEW_OUTCOMES, ROUTES, ROUTE_TABLE, RUN_STATES, escalationReason, fixFirstEscalation, mergeableState, nextCloserStreak, roundKind, routeFor, type MergeableState, type ReviewOutcome, type Route, type RunState } from "./route-table.js";
import { readPath } from "../narrow.js";

const MERGE_COLUMN: Partial<Record<ReviewOutcome, Route>> = { MERGE: "merge", "no-verdict": "fresh-reviewer", timeout: "fresh-reviewer", "external-hold": "await-external", "not-started": "retry-review", throttled: "fresh-reviewer" };

/** The routing rules in the order they bind, written apart from the table so each cell is checked against the rule. */
function expectedRoute(run: RunState, state: MergeableState, outcome: ReviewOutcome): Route {
  if (run !== "open") return "end-run";
  if (outcome === "head-moved") return "new-cycle";
  if (outcome === "FIX_FIRST" || state === "dirty") return "wake-fixer";
  if (state === "draft") return "end-run";
  // An exhausted account never takes a head on toward the merge decision unreviewed; its head is reviewed again once the hold lifts.
  if (outcome === "account-exhausted") return "await-account";
  // A behind head whose reviewer never started, or went silent under the machine stop, still needs its review before the merge decision.
  if (state === "behind") return outcome === "not-started" || outcome === "throttled" ? "retry-review" : "update-branch";
  if (state === "unknown") return "new-cycle";
  return MERGE_COLUMN[outcome]!;
}

const CELLS = RUN_STATES.flatMap((run) => MERGEABLE_STATES.flatMap((state) => REVIEW_OUTCOMES.map((outcome) => [run, state, outcome] as const)));

describe("the Shepherd route table", () => {
  it("has 216 cells: 3 run states x 8 mergeable states x 9 review outcomes", () => {
    expect(CELLS).toHaveLength(216);
  });

  it("gives every cell a route, so a missing state or outcome fails here", () => {
    const missing = CELLS.filter(([run, state, outcome]) => !(ROUTES as readonly unknown[]).includes(readPath(ROUTE_TABLE, run, state, outcome)));

    expect(missing).toEqual([]);
  });

  it("holds no state or outcome the axes do not name", () => {
    expect(Object.keys(ROUTE_TABLE).sort()).toEqual([...RUN_STATES].sort());
    for (const run of RUN_STATES) {
      expect(Object.keys(ROUTE_TABLE[run]).sort()).toEqual([...MERGEABLE_STATES].sort());
      for (const state of MERGEABLE_STATES) expect(Object.keys(ROUTE_TABLE[run][state]).sort()).toEqual([...REVIEW_OUTCOMES].sort());
    }
  });

  it.each(CELLS)("routes a %s PR in state %s with review outcome %s", (run, state, outcome) => {
    expect(routeFor(run, state, outcome)).toBe(expectedRoute(run, state, outcome));
  });
});

describe("mergeableState", () => {
  it.each([
    ["clean", false, "clean"],
    ["behind", false, "behind"],
    ["clean", true, "draft"],
    ["some-new-state", false, "unknown"],
  ] as const)("reads GitHub's %s (draft %s) as %s", (raw, draft, expected) => {
    expect(mergeableState(raw, draft)).toBe(expected);
  });
});

describe("roundKind", () => {
  it.each([
    ["fresh-reviewer", "timeout", "stuck"],
    ["fresh-reviewer", "no-verdict", "stuck"],
    ["await-external", "external-hold", "stuck"],
    ["wake-fixer", "MERGE", "stuck"],
    ["wake-fixer", "FIX_FIRST", "fix-first"],
    ["update-branch", "MERGE", "progress"],
    ["new-cycle", "head-moved", "progress"],
    ["merge", "MERGE", "progress"],
    ["retry-review", "not-started", "not-started"],
    ["wake-fixer", "not-started", "not-started"],
    ["fresh-reviewer", "throttled", "throttled"],
    ["retry-review", "throttled", "throttled"],
    ["wake-fixer", "throttled", "stuck"],
    ["end-run", "throttled", "progress"],
    ["new-cycle", "throttled", "progress"],
    ["await-account", "account-exhausted", "progress"],
  ] as const)("reads route %s on outcome %s as a %s round", (route, outcome, kind) => {
    expect(roundKind(route, outcome)).toBe(kind);
  });
});

describe("MAIN_CI_ROUTES", () => {
  it.each([
    ["green", "done"],
    ["red", "main-red"],
    ["cancelled", "wait"],
    ["cancelled-superseded", "read-newer-run"],
  ] as const)("routes a %s main CI read to %s", (read, route) => {
    expect(MAIN_CI_ROUTES[read]).toBe(route);
  });

  it("routes every read it names", () => {
    expect(Object.keys(MAIN_CI_ROUTES).sort()).toEqual([...MAIN_CI_READS].sort());
  });
});

describe("nextCloserStreak", () => {
  const no = { kind: "FIX_FIRST", closer: "no" };

  it("counts a head once when its cached verdict is routed again", () => {
    const first = nextCloserStreak({ streak: 0 }, "fix-first", no, "a");
    const replayed = nextCloserStreak(first, "fix-first", no, "a");

    expect(replayed.streak).toBe(1);
  });

  it("counts a second head that said no", () => {
    const first = nextCloserStreak({ streak: 0 }, "fix-first", no, "a");

    expect(nextCloserStreak(first, "fix-first", no, "b").streak).toBe(2);
  });

  it.each([
    ["a yes", "fix-first", { kind: "FIX_FIRST", closer: "yes" }],
    ["no closer field", "fix-first", { kind: "FIX_FIRST" }],
    ["a stuck round", "stuck", { kind: "none" }],
  ] as const)("resets on %s", (_name, kind, verdict) => {
    expect(nextCloserStreak({ streak: 1, head: "a" }, kind, verdict, "b")).toEqual({ streak: 0 });
  });
});

describe("escalationReason", () => {
  it("names the escalation's own words ahead of the detail", () => {
    expect(escalationReason("failed-rounds", "d")).toBe("3 review rounds failed at this task: d");
  });

  it("puts the given words in place of the escalation's own", () => {
    expect(escalationReason("failed-rounds", "d", "w")).toBe("w: d");
  });
});

describe("fixFirstEscalation", () => {
  const HEAD = "a".repeat(40);

  it("asks for a planner redesign or split at the third FIX_FIRST", () => {
    const escalated = fixFirstEscalation(3, 0, HEAD);

    expect(escalated).toEqual({ escalation: "fix-first-runaway", detail: `the last at ${HEAD}` });
    expect(escalationReason(escalated!.escalation, escalated!.detail)).toBe(
      `3 FIX_FIRST reviews at this task: route it to the planner to redesign or split it; Shepherd dispatches no further fix round: the last at ${HEAD}`,
    );
  });

  it("does not escalate at the second FIX_FIRST without a Closer: no streak", () => {
    expect(fixFirstEscalation(2, 0, HEAD)).toBeUndefined();
  });

  it("checks the runaway cap before no-progress", () => {
    expect(fixFirstEscalation(3, 2, HEAD)?.escalation).toBe("fix-first-runaway");
    expect(fixFirstEscalation(2, 2, HEAD)?.escalation).toBe("no-progress");
  });
});
