import { fakeSha } from "@titan-design/github";
import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { DEPTH_FLOOR_REASON } from "@titan-design/review-panel";
import { UNPARSED_AFTER_CORRECTION } from "./correct-verdict.js";
import type { Verdict } from "./phases.js";
import { causeLabel, noteCarryStep, reviewCause, reviewCauseStats, type CarryProbe, type CauseFacts, type LastReview } from "./review-cause.js";

const H1 = fakeSha("cause-head-1");
const H2 = fakeSha("cause-head-2");
const MERGE: Verdict = { kind: "MERGE", headSha: H1, evidence: {} };
const FIX_FIRST: Verdict = { kind: "FIX_FIRST", headSha: H1, text: "missing test" };
const merged: LastReview = { headSha: H1, outcome: "MERGE", verdict: MERGE };

const facts = (overrides: Partial<CauseFacts> = {}): CauseFacts => ({ headSha: H2, ownerAsked: false, updated: new Set(), ...overrides });
const probed = (...steps: [string, unknown][]): CarryProbe => {
  const probe: CarryProbe = {};
  for (const [stepId, result] of steps) noteCarryStep(probe, stepId, result);
  return probe;
};
const scope = (kind: string | null, baseRef: string | null = "main"): [string, unknown] => ["sh-carry-scope:0", { kind, baseRef }];
const tree: [string, unknown] = [`sh-carry:${H2}`, { equal: false, reason: "the trees differ" }];
const remerge = (reason: string): [string, unknown] => [`sh-remerge:${H2}`, { carries: false, reason }];

describe("reviewCause", () => {
  it.each<[string, CauseFacts, ReturnType<typeof reviewCause>]>([
    ["the run's first review", facts({ headSha: H1 }), { cause: "first" }],
    ["a new head after a FIX_FIRST", facts({ last: { headSha: H1, outcome: "FIX_FIRST", verdict: FIX_FIRST }, woken: "review" }), { cause: "fix-round" }],
    ["a new head after a NO_REPRO", facts({ last: { headSha: H1, outcome: "FIX_FIRST", verdict: { kind: "NO_REPRO", headSha: H1, result: {} } }, woken: "fix-proof" }), { cause: "fix-round" }],
    ["a FIX_FIRST chain that went red before green", facts({ last: { headSha: H1, outcome: "FIX_FIRST", verdict: FIX_FIRST }, woken: "ci-red" }), { cause: "fix-round" }],
    ["a new head after a conflict wake", facts({ last: merged, woken: "conflict" }), { cause: "conflict" }],
    ["a new head after a ci-red wake", facts({ last: merged, woken: "ci-red" }), { cause: "ci-fix" }],
    ["a head that moved while it was under review", facts({ last: { ...merged, outcome: "head-moved" } }), { cause: "superseded" }],
    ["Shepherd's update-branch after a review with no MERGE", facts({ last: { headSha: H1, outcome: "no-verdict", verdict: { kind: "none" } }, updated: new Set([H2]) }), { cause: "update-branch" }],
    ["a seat push after a review with no MERGE", facts({ last: { headSha: H1, outcome: "timeout", verdict: { kind: "none", cause: "timeout" } } }), { cause: "seat-push" }],
    ["a merge-up whose tree and remerge probes refused", facts({ last: merged, updated: new Set([H2]), carry: probed(scope("feature"), tree, remerge(`${H2} is not ${H1} plus one merge`)) }), { cause: "merge-up-not-carried", reason: "not-one-merge" }],
    ["a merge-up whose merge touched reviewed paths", facts({ last: merged, updated: new Set([H2]), carry: probed(scope("feature"), tree, remerge("the merge changed 2 path(s) outside the declared generated files")) }), { cause: "merge-up-not-carried", reason: "remerge-touched" }],
    ["a merge-up whose base is off the branch", facts({ last: merged, updated: new Set([H2]), carry: probed(scope("feature"), tree, remerge(`second parent ${H1} is not on main`)) }), { cause: "merge-up-not-carried", reason: "base-off-branch" }],
    ["a merge-up a seat objected to", facts({ last: merged, updated: new Set([H2]), carry: probed(scope("refactor"), [`sh-carry:${H2}`, { equal: true, headTree: "t", mergeTree: "t" }], [`sh-carry-seat:${H2}`, { clear: false, reason: "a seat reviewer said FIX_FIRST" }]) }), { cause: "merge-up-not-carried", reason: "seat" }],
    ["a merge-up with no base branch", facts({ last: merged, updated: new Set([H2]), carry: probed(scope("feature", null)) }), { cause: "merge-up-not-carried", reason: "base-unknown" }],
    ["a merge-up whose probe failed", facts({ last: merged, updated: new Set([H2]), carry: probed(scope("feature"), tree, remerge("git fetch failed")) }), { cause: "merge-up-not-carried", reason: "probe-failed" }],
    ["a seat push after a MERGE that did not carry", facts({ last: merged, carry: probed(scope("feature"), tree, remerge(`${H2} is not ${H1} plus one merge`)) }), { cause: "seat-push", reason: "not-one-merge" }],
    ["a security merge-up", facts({ last: merged, updated: new Set([H2]), carry: probed(scope("security")) }), { cause: "kind-no-carry", reason: "security" }],
    ["a merge-up of an unregistered kind", facts({ last: merged, updated: new Set([H2]), carry: probed(scope(null)) }), { cause: "kind-no-carry", reason: "unregistered" }],
    ["a silent reviewer's fresh retry", facts({ headSha: H1, last: { headSha: H1, outcome: "timeout", verdict: { kind: "none", cause: "timeout" } } }), { cause: "retry", reason: "timeout" }],
    ["a refused reviewer's retry", facts({ headSha: H1, last: { headSha: H1, outcome: "no-verdict", verdict: { kind: "none", cause: "no-verdict" } } }), { cause: "retry", reason: "no-verdict" }],
    ["a verdict below the depth floor", facts({ headSha: H1, last: { headSha: H1, outcome: "no-verdict", verdict: { kind: "none", cause: "no-verdict", reason: DEPTH_FLOOR_REASON } } }), { cause: "retry", reason: "depth-floor" }],
    ["a verdict that did not parse after its correction", facts({ headSha: H1, last: { headSha: H1, outcome: "timeout", verdict: { kind: "none", cause: "timeout", reason: `${UNPARSED_AFTER_CORRECTION} (no_block)` } } }), { cause: "retry", reason: "malformed" }],
    ["a reviewer a busy broker never started", facts({ headSha: H1, last: { headSha: H1, outcome: "not-started", verdict: { kind: "none", cause: "not-started" } } }), { cause: "retry", reason: "not-started" }],
    ["a hold's reviewer read again", facts({ headSha: H1, last: { headSha: H1, outcome: "external-hold", verdict: { kind: "none", cause: "external-hold" } } }), { cause: "hold" }],
    ["a resync that asked for the review again", facts({ headSha: H1, last: merged, ownerAsked: true }), { cause: "owner-request" }],
    ["a same-head review with nothing to explain it", facts({ headSha: H1, last: merged }), { cause: "unknown" }],
  ])("names %s", (_case, input, expected) => {
    expect(reviewCause(input)).toEqual(expected);
  });

  it("labels a cause with its reason in parentheses", () => {
    expect([causeLabel({ cause: "first" }), causeLabel({ cause: "merge-up-not-carried", reason: "seat" })]).toEqual(["first", "merge-up-not-carried(seat)"]);
  });
});

const DAY = Date.parse("2026-10-07T12:00:00Z");
const intentAt = (head: string, at: number, cause?: unknown): StepResult => ({
  stepId: `sh-review-intent:${head}`,
  iteration: 0,
  operation: "dispatch",
  agentId: null,
  signal: null,
  completedAt: new Date(at).toISOString(),
  data: { result: { kind: "intent", head, reviewer: "rv", at, mode: "spawn", ...(cause !== undefined && { cause }) } },
});
const runOf = (repo: string, results: StepResult[]): WorkflowRun =>
  ({ runId: `run-${repo}`, workflowName: "shepherd-pr", params: { repo }, status: "completed", error: null, stepResults: Object.fromEntries(results.map((result, i) => [`dispatch:${result.stepId}:${i}`, result])) }) as unknown as WorkflowRun;

describe("reviewCauseStats", () => {
  it("counts each recorded cause per repo and ISO week, and counts a run recorded before causes as unknown", () => {
    const runs = [
      runOf("Acme/Widgets", [intentAt(H1, DAY, { cause: "first" }), intentAt(H2, DAY + 60_000, { cause: "merge-up-not-carried", reason: "not-one-merge" })]),
      runOf("acme/widgets", [intentAt(H1, DAY, { cause: "first" })]),
      runOf("acme/old", [intentAt(H1, DAY), intentAt(H2, DAY, { cause: "not-a-cause" })]),
    ];

    expect(reviewCauseStats(runs)).toEqual([
      { repo: "acme/old", week: "2026-W41", reviews: 2, causes: { unknown: 2 } },
      { repo: "acme/widgets", week: "2026-W41", reviews: 3, causes: { first: 2, "merge-up-not-carried(not-one-merge)": 1 } },
    ]);
  });

  it("skips intents that named no reviewer and intents outside the range", () => {
    const none: StepResult = { ...intentAt(H1, DAY), data: { result: { kind: "none", reason: "no reviewer dispatch is wired" } } };
    const runs = [runOf("acme/widgets", [none, intentAt(H2, DAY - 7 * 86_400_000, { cause: "first" })])];

    expect(reviewCauseStats(runs, { from: "2026-10-07" })).toEqual([]);
  });
});
