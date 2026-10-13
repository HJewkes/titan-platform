import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { stepName } from "./stats.js";
import type { TrainShadow } from "./train-shadow.js";
import { trainShadowStats } from "./train-shadow-stats.js";

const T0 = Date.parse("2026-09-15T10:00:00Z");
const MIN = 60_000;
const iso = (at: number): string => new Date(at).toISOString();

type Step = [key: string, at: number, payload: Record<string, unknown>];

function run(pr: number, steps: Step[], repo = "Acme/Widgets"): WorkflowRun {
  const stepResults = Object.fromEntries(steps.map(([key, at, payload], i) => [key, { stepId: stepName(key), iteration: i, agentId: null, signal: null, completedAt: iso(at), data: { result: payload } }]));
  return { id: `run-${pr}`, workflowName: "shepherd-pr", params: { repo, pr: String(pr) }, status: "completed", currentStep: null, stepResults, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: iso(T0), completedAt: iso(T0), error: null };
}

const merged = (at: number): Step => ["merge:0", at, { done: true, mergeSha: "m" }];

/** A green head whose base moved, its land-time refresh, and the first CI verdict at the refreshed head. */
function refreshed(pr: number, verdict: "red" | "green", at = T0): Step[] {
  return [
    ["ci-wait:0", at, { verdict: "behind", headSha: `pre-${pr}`, checksGreen: true, baseMoved: true }],
    ["update-branch:0", at + MIN, { headSha: `post-${pr}`, own: true }],
    ["ci-wait:1", at + 20 * MIN, { verdict, headSha: `post-${pr}` }],
  ];
}

function shadow(pr: number, at: number, peers: number[], fields: Partial<TrainShadow> = {}): TrainShadow {
  return { runId: `run-${pr}`, stepId: "update-branch:0", repo: "acme/widgets", pr, headSha: `pre-${pr}`, at: iso(at), peers: peers.map((peer) => ({ runId: `run-${peer}`, pr: peer, headSha: `pre-${peer}`, stage: "train" })), excluded: [], disjoint: "overlap", ...fields };
}

describe("trainShadowStats", () => {
  it("counts a refresh head that went red after a green pre-refresh head", () => {
    const strictChase: Step[] = [
      ["ci-wait:0", T0, { verdict: "behind", headSha: "strict" }],
      ["update-branch:0", T0 + MIN, { headSha: "strict-up", own: true }],
      ["ci-wait:1", T0 + 2 * MIN, { verdict: "red", headSha: "strict-up" }],
    ];

    const [row] = trainShadowStats([], [run(1, refreshed(1, "red")), run(2, refreshed(2, "green")), run(3, strictChase)]);

    expect(row).toMatchObject({ refreshJudged: 2, refreshRed: 1, refreshRedRate: 0.5 });
  });

  it("averages batch size over the shadows a batch would take, and leaves a held run's own shadow out", () => {
    const shadows = [shadow(1, T0, [2]), shadow(3, T0, []), shadow(4, T0, [5, 6], { selfExcluded: "held" })];

    expect(trainShadowStats(shadows, [])[0]).toMatchObject({ shadows: 3, admissible: 2, meanBatch: 1.5, maxBatch: 2 });
  });

  it("names a merge between the shadow and the run's own merge that was not one of its peers", () => {
    const runs = [run(1, [merged(T0 + 30 * MIN)]), run(2, [merged(T0 + 10 * MIN)]), run(3, [merged(T0 + 20 * MIN)]), run(4, [merged(T0 + 15 * MIN)])];

    const [row] = trainShadowStats([shadow(1, T0, [2]), shadow(4, T0, [2])], runs);

    expect(row).toMatchObject({ landed: 2, outsideMoved: 1 });
  });

  it("counts a unit-disjoint verdict on every shadow", () => {
    expect(trainShadowStats([shadow(1, T0, [], { disjoint: "units-disjoint" }), shadow(2, T0, [])], [])[0]).toMatchObject({ unitsDisjoint: 1 });
  });
});
