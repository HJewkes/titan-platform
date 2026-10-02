import { describe, expect, it } from "vitest";
import { MAIN_CI_READS, MAIN_CI_ROUTES, MERGEABLE_STATES, REVIEW_OUTCOMES, ROUTES, ROUTE_TABLE, RUN_STATES, mergeableState, roundKind, routeFor, type MergeableState, type ReviewOutcome, type Route, type RunState } from "./route-table.js";

const MERGE_COLUMN: Partial<Record<ReviewOutcome, Route>> = { MERGE: "merge", "no-verdict": "fresh-reviewer", timeout: "fresh-reviewer", "external-hold": "await-external", "not-started": "retry-review" };

/** The routing rules in the order they bind, written apart from the table so each cell is checked against the rule. */
function expectedRoute(run: RunState, state: MergeableState, outcome: ReviewOutcome): Route {
  if (run !== "open") return "end-run";
  if (outcome === "head-moved") return "new-cycle";
  if (outcome === "FIX_FIRST" || state === "dirty") return "wake-fixer";
  if (state === "behind") return "update-branch";
  if (state === "unknown") return "new-cycle";
  if (state === "draft") return "end-run";
  return MERGE_COLUMN[outcome]!;
}

const CELLS = RUN_STATES.flatMap((run) => MERGEABLE_STATES.flatMap((state) => REVIEW_OUTCOMES.map((outcome) => [run, state, outcome] as const)));

describe("the Shepherd route table", () => {
  it("has 168 cells: 3 run states x 8 mergeable states x 7 review outcomes", () => {
    expect(CELLS).toHaveLength(168);
  });

  it("gives every cell a route, so a missing state or outcome fails here", () => {
    const missing = CELLS.filter(([run, state, outcome]) => !(ROUTES as readonly unknown[]).includes(ROUTE_TABLE[run]?.[state]?.[outcome]));

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
  ] as const)("reads route %s on outcome %s as a %s round", (route, outcome, kind) => {
    expect(roundKind(route, outcome)).toBe(kind);
  });
});

describe("MAIN_CI_ROUTES", () => {
  it.each([
    ["green", "done"],
    ["red", "main-red"],
    ["cancelled", "main-red"],
    ["cancelled-superseded", "read-newer-run"],
  ] as const)("routes a %s main CI read to %s", (read, route) => {
    expect(MAIN_CI_ROUTES[read]).toBe(route);
  });

  it("routes every read it names", () => {
    expect(Object.keys(MAIN_CI_ROUTES).sort()).toEqual([...MAIN_CI_READS].sort());
  });
});
