// A synthetic autoresearch run for the twin's `autoresearch.*` answers: three rounds, one idea kept, one superseded, one
// stopped at L0, one rejected at L2, one still implementing and one in its seed eval. Every id, sha and metric name is invented.
import type { ArLadder, ArRunSummary, ArRunView } from "../autoresearch-view.js";
import { TWIN_NOW } from "./clock.js";

const MINUTE = 60_000;
const at = (minutesAgo: number): string => new Date(TWIN_NOW - minutesAgo * MINUTE).toISOString();

const PIN = "9e1d4b7a2c5f8e0d3a6b9c2e5f8a1d4b7c0e3f6a";
const KEPT_HEAD = "4a7c0e3f6a9d2b5e8c1f4a7d0b3e6c9f2a5d8b1e";
const SUPERSEDED_HEAD = "7d0b3e6c9f2a5d8b1e4a7c0e3f6a9d2b5e8c1f4a";

type Idea = ArLadder["idea"];
type EvalRun = ArLadder["evals"][number];

function idea(id: string, round: number, cell: string, overrides: Partial<Idea> = {}): Idea {
  const [kind = cell, direction = ""] = cell.split(":");
  return {
    id, round, cell, class: kind, direction, hypothesis: `Synthetic hypothesis for ${cell}`, priority: 5, bold: false, source: "planner", lineage: id,
    expectedEffect: { metric: "score", direction: "down", microSignal: "fewer accepts in the replay" },
    ...overrides,
  };
}

function evalRun(repeat: string, score: number): EvalRun {
  return { case: "seed-a", repeat, metrics: { score }, gates: { all_gate: true }, violations: { hidden_regressions: 0 }, usd: 0.3, wallS: 240 };
}

const KEPT = idea("i-3f9a0c1d2e4b", 1, "accept-gate:stricter-tree", { priority: 9 });
const SUPERSEDED = idea("i-0d4e8f2a6b1c", 1, "config-param:lower-thresh", { priority: 7, bold: true });
const L0_STOP = idea("i-5b3c7e9a1d0f", 2, "planner-ranking:fanout-first");
const L2_REJECT = idea("i-c81e5a7f3b20", 2, "config-param:raise-slack");
const RUNNING = idea("i-77aa2b4c6d8e", 3, "accept-gate:per-file-cap", { source: "followup", parent: KEPT.id, lineage: KEPT.id });
const EVALUATING = idea("i-c22d9e1f3a5b", 3, "config-param:widen-band", { priority: 6 });
const REQUEUED = { ...SUPERSEDED, round: 2, source: "requeue" as const };

const ladderSteps = (round: number, id: string, steps: readonly string[], endedAgo: number) =>
  steps.map((step, index) => ({ stepId: `ar-${step}:${round}/${id}`, completedAt: at(endedAgo + (steps.length - index) * 6) }));

const SEED_STEPS = ["alloc", "implement", "l0", "l1", "eval", "eval", "eval"] as const;

const keptLadder: ArLadder = {
  idea: KEPT, implementer: { agent: "ar-impl-7c1e-1", sessionId: "00000000-0000-4000-8000-00000000a001" }, active: null, completed: ladderSteps(1, KEPT.id, [...SEED_STEPS, "eval", "eval", "release"], 300), implementUsd: 1.6,
  l0: { ok: true }, micro: { predictedDirectionMet: true },
  evals: [evalRun("r1", 230.9), evalRun("r2", 231.6), evalRun("r3", 231.2), evalRun("c1", 231.0), evalRun("c2", 231.3)],
  outcome: { verdict: "kept", reason: "confirmed", rungReached: "L3", delta: 1.2, sigma: 0.62, head: KEPT_HEAD, branch: `ar/${KEPT.id}`, lesson: "A stricter tree gate holds on every seed" },
};

const supersededLadder: ArLadder = {
  idea: SUPERSEDED, implementer: { agent: "ar-impl-7c1e-2" }, active: null, completed: ladderSteps(1, SUPERSEDED.id, [...SEED_STEPS, "release"], 310), implementUsd: 1.1,
  l0: { ok: true }, micro: { predictedDirectionMet: true }, evals: [evalRun("r1", 232.0), evalRun("r2", 232.2), evalRun("r3", 231.9)],
  outcome: { verdict: "stopped", reason: "superseded", rungReached: "L3", delta: 0.9, sigma: 0.62, head: SUPERSEDED_HEAD, branch: `ar/${SUPERSEDED.id}` },
};

const l0Ladder: ArLadder = {
  idea: L0_STOP, implementer: null, active: null, completed: ladderSteps(2, L0_STOP.id, ["alloc", "implement", "l0", "release"], 150), implementUsd: 0.8,
  l0: { ok: false, code: "unit" }, micro: null, evals: [],
  outcome: { verdict: "rejected", reason: "rejected:post:unit", rungReached: "L0", sigma: 0.62, lesson: "The unit suite pins the old ranking order" },
};

const l2Ladder: ArLadder = {
  idea: L2_REJECT, implementer: { agent: "ar-impl-7c1e-5", sessionId: "00000000-0000-4000-8000-00000000a005" }, active: null, completed: ladderSteps(2, L2_REJECT.id, ["alloc", "implement", "l0", "l1", "eval", "release"], 200), implementUsd: 1.3,
  l0: { ok: true }, micro: { predictedDirectionMet: true }, evals: [evalRun("r1", 232.8)],
  outcome: { verdict: "rejected", reason: "clearly-worse", rungReached: "L2", delta: -1.6, sigma: 0.62, lesson: "A looser slack lets the hidden cases through" },
};

const runningLadder: ArLadder = {
  idea: RUNNING, implementer: { agent: "ar-impl-7c1e-3", sessionId: "00000000-0000-4000-8000-00000000a003", resumedFrom: KEPT.id }, active: { stepId: `ar-implement:3/${RUNNING.id}`, firstStartedAt: at(11), restarts: 0 },
  completed: ladderSteps(3, RUNNING.id, ["alloc"], 11), implementUsd: null, l0: null, micro: null, evals: [], outcome: null,
};

/** Its seed eval restarted once, so the timer runs from the first start, not the restart. */
const evaluatingLadder: ArLadder = {
  idea: EVALUATING, implementer: { agent: "ar-impl-7c1e-4" }, active: { stepId: `ar-eval:3/${EVALUATING.id}:r1`, firstStartedAt: at(6), restarts: 1 },
  completed: ladderSteps(3, EVALUATING.id, ["alloc", "implement", "l0", "l1"], 6), implementUsd: 1.2, l0: { ok: true }, micro: { predictedDirectionMet: true },
  evals: [], outcome: null,
};

const noPlannerNotes = { rejected: [], plannerRetried: false, analysis: [], exempt: {} };

const ROUNDS: ArRunView["rounds"] = [
  {
    round: 1, queue: [KEPT, SUPERSEDED], ...noPlannerNotes,
    selection: { picks: [KEPT.id, SUPERSEDED.id], draws: [{ id: KEPT.id, draw: 0.81 }, { id: SUPERSEDED.id, draw: 0.44 }], plannerTopK: [KEPT.id, SUPERSEDED.id] },
    ladders: [keptLadder, supersededLadder], ratchet: { from: PIN, to: KEPT_HEAD },
  },
  {
    round: 2, queue: [L0_STOP, L2_REJECT, REQUEUED], rejected: [{ code: "dead-end" }], plannerRetried: true, analysis: ["The ranking tests assume a fixed order"],
    exempt: { followup: "The kept gate has no sibling cell left to try" },
    selection: { picks: [L0_STOP.id, L2_REJECT.id], draws: [{ id: L0_STOP.id, draw: 0.63 }, { id: L2_REJECT.id, draw: 0.57 }, { id: REQUEUED.id, draw: 0.21 }], plannerTopK: [L0_STOP.id, L2_REJECT.id] },
    ladders: [l0Ladder, l2Ladder], ratchet: null,
  },
  {
    round: 3, queue: [RUNNING, EVALUATING, REQUEUED], rejected: [{ code: "duplicate" }, { code: "bounds" }], plannerRetried: false, analysis: [],
    exempt: { bold: "The requeued bold idea still stands in the pool" },
    selection: {
      picks: [RUNNING.id, EVALUATING.id],
      draws: [{ id: RUNNING.id, draw: 0.72 }, { id: EVALUATING.id, draw: 0.55 }, { id: REQUEUED.id, draw: 0.38 }],
      plannerTopK: [RUNNING.id, REQUEUED.id],
    },
    ladders: [runningLadder, evaluatingLadder], ratchet: null,
  },
];

export const AR_RUN_FIXTURE: ArRunView = {
  runId: "ar-7c1e", status: "running", startedAt: at(420), completedAt: null, error: null,
  target: {
    name: "fixture-target", pin: PIN, ratchetRef: "refs/heads/ar/ratchet/ar-7c1e", phases: ["p1"], repo: "example-org/example-target", ratchetPrefix: "ar/ratchet",
    metric: {
      primary: "score", direction: "min", guards: ["guard_delta"], zeroTolerance: ["hidden_regressions"], allGate: ["all_gate"], noOp: ["changed_tasks"],
      noise: { bandSigmas: 2, lockAfterPairs: 5, minPairs: 3, defaultBandPp: 1.5 },
    },
  },
  settings: { lanes: 3, rounds: 50, minPool: 12 },
  baseline: { runs: [evalRun("b1", 234.1), evalRun("b2", 234.6), evalRun("b3", 234.3), evalRun("b4", 234.8)], b0: 234.5 },
  best: { head: KEPT_HEAD, primary: 231.2 },
  rounds: ROUNDS,
  registries: {
    deadEnds: [
      { cell: SUPERSEDED.cell, targets: ["src/thresholds.ts"], rungFailed: "L3", deltaOverSigma: 0.9 / 0.62 },
      { cell: L2_REJECT.cell, targets: ["src/slack.ts"], rungFailed: "L2", deltaOverSigma: -1.6 / 0.62, lesson: "A looser slack lets the hidden cases through" },
    ],
    bugs: [{ symptom: "rejected:post:unit", fix: "The unit suite pins the old ranking order", source: "L0" }, { symptom: "The ranking tests assume a fixed order", fix: "", source: "planner" }],
  },
  cells: [
    { cell: "accept-gate:stricter-tree", trials: 1, meanAbsDeltaOverSigma: 1.9, keepRate: 1, flag: "explore" },
    { cell: "config-param:lower-thresh", trials: 1, meanAbsDeltaOverSigma: 1.5, keepRate: 0, flag: "explore" },
    { cell: "planner-ranking:fanout-first", trials: 1, meanAbsDeltaOverSigma: 0, keepRate: 0, flag: "explore" },
    { cell: "config-param:raise-slack", trials: 1, meanAbsDeltaOverSigma: 2.6, keepRate: 0, flag: "demote" },
  ],
};

/** The fixture's row in `autoresearch.runs`; spend is every implement and eval dollar the run view carries. */
export const AR_RUN_SUMMARY: ArRunSummary = {
  runId: AR_RUN_FIXTURE.runId, target: AR_RUN_FIXTURE.target.name, phase: AR_RUN_FIXTURE.target.phases[0]!, round: 3, rounds: AR_RUN_FIXTURE.settings.rounds, status: AR_RUN_FIXTURE.status,
  startedAt: AR_RUN_FIXTURE.startedAt, completedAt: AR_RUN_FIXTURE.completedAt, best: AR_RUN_FIXTURE.best, spend: 9.9,
};
