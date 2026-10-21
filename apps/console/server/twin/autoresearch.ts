// A synthetic autoresearch run for the twin and the placeholder page: three rounds, one idea kept, one superseded, one
// stopped at L0 and one still implementing. Every id, sha and metric name is invented.
import type { ArLadder, ArRunView } from "../autoresearch-view.js";
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
const RUNNING = idea("i-77aa2b4c6d8e", 3, "accept-gate:per-file-cap", { source: "followup", parent: KEPT.id, lineage: KEPT.id });
const REQUEUED = { ...SUPERSEDED, round: 2, source: "requeue" as const };

const ladderSteps = (round: number, id: string, steps: readonly string[], endedAgo: number) =>
  steps.map((step, index) => ({ stepId: `ar-${step}:${round}/${id}`, completedAt: at(endedAgo + (steps.length - index) * 6) }));

const SEED_STEPS = ["alloc", "implement", "l0", "l1", "eval", "eval", "eval"] as const;

const keptLadder: ArLadder = {
  idea: KEPT, active: null, completed: ladderSteps(1, KEPT.id, [...SEED_STEPS, "eval", "eval", "release"], 300), implementUsd: 1.6,
  l0: { ok: true }, micro: { predictedDirectionMet: true },
  evals: [evalRun("r1", 230.9), evalRun("r2", 231.6), evalRun("r3", 231.2), evalRun("c1", 231.0), evalRun("c2", 231.3)],
  outcome: { verdict: "kept", reason: "confirmed", rungReached: "L3", delta: 1.2, sigma: 0.62, head: KEPT_HEAD, branch: `ar/${KEPT.id}`, lesson: "A stricter tree gate holds on every seed" },
};

const supersededLadder: ArLadder = {
  idea: SUPERSEDED, active: null, completed: ladderSteps(1, SUPERSEDED.id, [...SEED_STEPS, "release"], 310), implementUsd: 1.1,
  l0: { ok: true }, micro: { predictedDirectionMet: true }, evals: [evalRun("r1", 232.0), evalRun("r2", 232.2), evalRun("r3", 231.9)],
  outcome: { verdict: "stopped", reason: "superseded", rungReached: "L3", delta: 0.9, sigma: 0.62, head: SUPERSEDED_HEAD, branch: `ar/${SUPERSEDED.id}` },
};

const l0Ladder: ArLadder = {
  idea: L0_STOP, active: null, completed: ladderSteps(2, L0_STOP.id, ["alloc", "implement", "l0", "release"], 150), implementUsd: 0.8,
  l0: { ok: false, code: "unit" }, micro: null, evals: [],
  outcome: { verdict: "rejected", reason: "rejected:post:unit", rungReached: "L0", sigma: 0.62, lesson: "The unit suite pins the old ranking order" },
};

const runningLadder: ArLadder = {
  idea: RUNNING, active: { stepId: `ar-implement:3/${RUNNING.id}`, firstStartedAt: at(11), restarts: 0 },
  completed: ladderSteps(3, RUNNING.id, ["alloc"], 11), implementUsd: null, l0: null, micro: null, evals: [], outcome: null,
};

const noPlannerNotes = { rejected: [], plannerRetried: false, analysis: [] };

const ROUNDS: ArRunView["rounds"] = [
  {
    round: 1, queue: [KEPT, SUPERSEDED], ...noPlannerNotes,
    selection: { picks: [KEPT.id, SUPERSEDED.id], draws: [{ id: KEPT.id, draw: 0.81 }, { id: SUPERSEDED.id, draw: 0.44 }], plannerTopK: [KEPT.id, SUPERSEDED.id] },
    ladders: [keptLadder, supersededLadder], ratchet: { from: PIN, to: KEPT_HEAD },
  },
  {
    round: 2, queue: [L0_STOP, REQUEUED], rejected: [{ code: "dead-end" }], plannerRetried: true, analysis: ["The ranking tests assume a fixed order"],
    selection: { picks: [L0_STOP.id], draws: [{ id: L0_STOP.id, draw: 0.63 }, { id: REQUEUED.id, draw: 0.21 }], plannerTopK: [L0_STOP.id] },
    ladders: [l0Ladder], ratchet: null,
  },
  {
    round: 3, queue: [RUNNING, REQUEUED], ...noPlannerNotes,
    selection: { picks: [RUNNING.id], draws: [{ id: RUNNING.id, draw: 0.72 }], plannerTopK: [RUNNING.id, REQUEUED.id] },
    ladders: [runningLadder], ratchet: null,
  },
];

export const AR_RUN_FIXTURE: ArRunView = {
  runId: "ar-7c1e", status: "running", startedAt: at(420), completedAt: null, error: null,
  target: {
    name: "fixture-target", pin: PIN, ratchetRef: "refs/heads/ar/ratchet/ar-7c1e", phases: ["p1"],
    metric: {
      primary: "score", direction: "min", guards: ["guard_delta"], zeroTolerance: ["hidden_regressions"], allGate: ["all_gate"], noOp: ["changed_tasks"],
      noise: { bandSigmas: 2, lockAfterPairs: 5, minPairs: 3, defaultBandPp: 1.5 },
    },
  },
  settings: { lanes: 3, rounds: 50, minPool: 12 },
  baseline: { runs: [evalRun("b1", 234.1), evalRun("b2", 234.6), evalRun("b3", 234.3), evalRun("b4", 234.8)], b0: 234.5 },
  best: { head: KEPT_HEAD, primary: 231.2 },
  rounds: ROUNDS,
  registries: { deadEnds: [], bugs: [{ symptom: "rejected:post:unit", fix: "The unit suite pins the old ranking order", source: "L0" }, { symptom: "The ranking tests assume a fixed order", fix: "", source: "planner" }] },
  cells: [
    { cell: "accept-gate:stricter-tree", trials: 1, meanAbsDeltaOverSigma: 1.9, keepRate: 1, flag: "explore" },
    { cell: "config-param:lower-thresh", trials: 1, meanAbsDeltaOverSigma: 1.5, keepRate: 0, flag: "explore" },
    { cell: "planner-ranking:fanout-first", trials: 1, meanAbsDeltaOverSigma: 0, keepRate: 0, flag: "explore" },
  ],
};
