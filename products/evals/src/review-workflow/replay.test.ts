import { DEFAULT_PANEL_TABLE } from "@titan-design/review-panel";
import { describe, expect, it } from "vitest";
import { FAILURE_FIXTURES, SEED_CASES } from "./cases.js";
import { replayCase, replaySuite, type ReplayVariant } from "./replay.js";
import { replayExpectedSchema } from "./scenario.js";
import { replayWorld } from "./test-fixture.js";

const INCUMBENT: ReplayVariant = {
  id: "incumbent",
  policy: {
    plan: { panel: { roles: { g10: "bd-reviewer", standard: "reviewer" }, shapeRoles: { adversary: { g10: "fable-reviewer", standard: "fable-reviewer" } }, panel: DEFAULT_PANEL_TABLE } },
    timing: { pollMs: 1_000, startDeadlineMs: 5_000, verdictDeadlineMs: 10_000 },
  },
};

const caseNamed = (id: string) => {
  const found = [...SEED_CASES, ...FAILURE_FIXTURES].find((evalCase) => evalCase.id === id);
  if (found === undefined) throw new Error(`no case ${id}`);
  return found;
};

describe("the review-workflow failure-fixture suite", () => {
  it.each(FAILURE_FIXTURES.map((evalCase) => [evalCase.id, evalCase] as const))("replays %s to its recorded outcome with fake ports and no model", async (_id, evalCase) => {
    const expected = replayExpectedSchema.parse(evalCase.expected);

    const result = await replayCase(evalCase, INCUMBENT, replayWorld);

    expect({ outcome: result.outcome, sessions: result.sessions, matched: result.matched }).toEqual({ outcome: expected.outcome, sessions: expected.sessions, matched: true });
  });
});

describe("the review-workflow seed cases", () => {
  it("catch the three blocking heads and none of the fixed heads", async () => {
    const results = await replaySuite(SEED_CASES, [INCUMBENT], replayWorld);

    expect(results.map(({ caseId, hit, falseCatch, matched }) => ({ caseId, hit, falseCatch, matched }))).toEqual([
      { caseId: "seed-tp747-empty-contexts", hit: true, falseCatch: false, matched: true },
      { caseId: "seed-tp754-ci-failed-abandon", hit: true, falseCatch: false, matched: true },
      { caseId: "seed-tp755-codeowners-unprotected", hit: true, falseCatch: false, matched: true },
      { caseId: "seed-tp755-fixed-merge-up", hit: false, falseCatch: false, matched: true },
      { caseId: "seed-tp755-codeowners-kept", hit: false, falseCatch: false, matched: true },
    ]);
  });

  it("count no catch at 84dc2b72, whose FIX_FIRST cites only a line past the file's end", async () => {
    const result = await replayCase(caseNamed("seed-tp755-fixed-merge-up"), INCUMBENT, replayWorld);

    expect({ outcome: result.outcome, hit: result.hit, falseCatch: result.falseCatch }).toEqual({ outcome: "FIX_FIRST", hit: false, falseCatch: false });
  });

  it("key each result by the case's content hash and the variant's policy hash", async () => {
    const slower: ReplayVariant = { id: "slower", policy: { ...INCUMBENT.policy, timing: { pollMs: 2_000, startDeadlineMs: 5_000, verdictDeadlineMs: 10_000 } } };

    const [first, second] = await replaySuite([caseNamed("seed-tp755-codeowners-kept")], [INCUMBENT, slower], replayWorld);

    expect([first?.caseHash === second?.caseHash, first?.variantHash === second?.variantHash]).toEqual([true, false]);
  });
});
