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

/** Rounds recorded before C-256 S5a list no move and no re-evaluation. */
const BEFORE_S5 = { moves: [], reevals: [] };

const ROUNDS: ArRunView["rounds"] = [
  {
    round: 1, queue: [KEPT, SUPERSEDED], ...noPlannerNotes,
    selection: { picks: [KEPT.id, SUPERSEDED.id], draws: [{ id: KEPT.id, draw: 0.81 }, { id: SUPERSEDED.id, draw: 0.44 }], plannerTopK: [KEPT.id, SUPERSEDED.id] },
    ladders: [keptLadder, supersededLadder], ratchet: { from: PIN, to: KEPT_HEAD }, ...BEFORE_S5,
  },
  {
    round: 2, queue: [L0_STOP, L2_REJECT, REQUEUED], rejected: [{ code: "dead-end" }], plannerRetried: true, analysis: ["The ranking tests assume a fixed order"],
    exempt: { followup: "The kept gate has no sibling cell left to try" },
    selection: { picks: [L0_STOP.id, L2_REJECT.id], draws: [{ id: L0_STOP.id, draw: 0.63 }, { id: L2_REJECT.id, draw: 0.57 }, { id: REQUEUED.id, draw: 0.21 }], plannerTopK: [L0_STOP.id, L2_REJECT.id] },
    ladders: [l0Ladder, l2Ladder], ratchet: null, ...BEFORE_S5,
  },
  {
    round: 3, queue: [RUNNING, EVALUATING, REQUEUED], rejected: [{ code: "duplicate" }, { code: "bounds" }], plannerRetried: false, analysis: [],
    exempt: { bold: "The requeued bold idea still stands in the pool" },
    selection: {
      picks: [RUNNING.id, EVALUATING.id],
      draws: [{ id: RUNNING.id, draw: 0.72 }, { id: EVALUATING.id, draw: 0.55 }, { id: REQUEUED.id, draw: 0.38 }],
      plannerTopK: [RUNNING.id, REQUEUED.id],
    },
    ladders: [runningLadder, evaluatingLadder], ratchet: null, ...BEFORE_S5,
  },
];

/** The run as a factory before C-256 S3a records it: no noise snapshot, lane, fork, usage, L0 rows or registry links. */
const PRE_S3A_RUN: ArRunView = {
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
  snapshots: [],
  snapshotPending: null,
  syncs: [],
};

type Outcome = NonNullable<ArLadder["outcome"]>;

/** What C-256 S3a adds to one ladder: the implementer's mode and account, the L0 rows and the outcome's noise, lane and spend. */
interface S3aFields {
  implementer: NonNullable<ArLadder["implementer"]>;
  checks?: NonNullable<NonNullable<ArLadder["l0"]>["checks"]>;
  outcome?: Pick<Outcome, "against" | "lane" | "fork" | "usage">;
}

const ACCOUNT = "fixture-account";
const passed = (name: string) => ({ name, ok: true, ms: 1800 });
const L0_PASSED = [passed("bounds-post"), passed("unit"), passed("test-proof")];

/** Round 1 is judged on four pairs, so σ is unlocked on the default band; the fifth pair locks it for round 2. */
const AGAINST_R1 = { case: "seed-a", head: PIN, bandWidth: 1.5, sigma: 0.62, pairs: 4, locked: false };
const AGAINST_R2 = { case: "seed-a", head: KEPT_HEAD, bandWidth: 1.24, sigma: 0.62, pairs: 5, locked: true };

const S3A: Record<string, S3aFields> = {
  [KEPT.id]: {
    implementer: { ...keptLadder.implementer!, mode: "spawn", account: ACCOUNT }, checks: L0_PASSED,
    outcome: { against: AGAINST_R1, lane: 1, fork: "explore", usage: { implementUsd: 1.6, evalUsd: 1.5, microUsd: 0.2 } },
  },
  [SUPERSEDED.id]: {
    implementer: { ...supersededLadder.implementer!, mode: "spawn", account: ACCOUNT }, checks: L0_PASSED,
    outcome: { against: AGAINST_R1, lane: 2, fork: "explore", usage: { implementUsd: 1.1, evalUsd: 0.9, microUsd: 0.2 } },
  },
  [L0_STOP.id]: {
    implementer: { agent: "ar-impl-7c1e-1", sessionId: "00000000-0000-4000-8000-00000000a001", resumedFrom: "ar-impl-7c1e-1", mode: "resume", account: ACCOUNT },
    checks: [passed("bounds-post"), { name: "unit", ok: false, code: "unit", ms: 4200 }, passed("test-proof")],
    outcome: { against: AGAINST_R2, lane: 1, fork: "exploit", usage: { implementUsd: 0.8, evalUsd: 0, microUsd: 0 } },
  },
  [L2_REJECT.id]: {
    implementer: { ...l2Ladder.implementer!, mode: "spawn", account: ACCOUNT }, checks: L0_PASSED,
    outcome: { against: AGAINST_R2, lane: 2, fork: "explore", usage: { implementUsd: 1.3, evalUsd: 0.3, microUsd: 0.2 } },
  },
  [RUNNING.id]: { implementer: { ...runningLadder.implementer!, resumedFrom: "ar-impl-7c1e-1", mode: "resume", account: ACCOUNT } },
  [EVALUATING.id]: { implementer: { ...evaluatingLadder.implementer!, mode: "spawn", account: ACCOUNT }, checks: L0_PASSED },
};

function withS3a(ladder: ArLadder): ArLadder {
  const added = S3A[ladder.idea.id];
  if (added === undefined) return ladder;
  return {
    ...ladder,
    implementer: added.implementer,
    l0: ladder.l0 === null || added.checks === undefined ? ladder.l0 : { ...ladder.l0, checks: added.checks },
    outcome: ladder.outcome === null ? null : { ...ladder.outcome, ...added.outcome },
  };
}

/** C-256 S4c's parent-chain length: the follow-up of the kept idea is one deep, every other idea a root. */
const withDepth = (entry: Idea): Idea => ({ ...entry, lineageDepth: entry.parent === undefined ? 0 : 1 });

const PLANNER_SESSION ="00000000-0000-4000-8000-00000000b001";

/** C-256 S3e: round 1's planner spawns fresh and later rounds resume its session, so the cache reads grow. */
const PLANNERS: Record<number, NonNullable<ArRunView["rounds"][number]["planner"]>> = {
  1: { agent: "ar-plan-7c1e", sessionId: PLANNER_SESSION, mode: "spawn", usage: { usd: 0.42, cacheReadTokens: 0, cacheWrite1hTokens: 18_400, retries: 0 } },
  2: { agent: "ar-plan-7c1e", sessionId: PLANNER_SESSION, mode: "resume", usage: { usd: 0.31, cacheReadTokens: 18_400, cacheWrite1hTokens: 6_200, retries: 1 } },
  3: { agent: "ar-plan-7c1e", sessionId: PLANNER_SESSION, mode: "resume", usage: { usd: 0.19, cacheReadTokens: 24_600, cacheWrite1hTokens: 3_100, retries: 0 } },
};

const SYNCED_MAIN = "2f5a8d1b4e7c0a3f6d9b2e5c8a1f4d7b0e3c6a9f";

/** C-256 S5a: round 1's kept idea fast-forwards the ratchet, and the superseded winner's merge onto it conflicts. */
const S5_ROUNDS: Record<number, Pick<ArRunView["rounds"][number], "moves" | "reevals">> = {
  1: {
    moves: [{ from: PIN, to: KEPT_HEAD, kind: "ff", ideaId: KEPT.id }],
    reevals: [{ ideaId: SUPERSEDED.id, from: PIN, vs: KEPT_HEAD, merge: null, conflict: ["src/thresholds.ts"], runs: [], decision: "requeued", reason: "conflict" }],
  },
};

function withReeval(round: ArRunView["rounds"][number], ladder: ArLadder): ArLadder {
  const reeval = round.reevals.find((entry) => entry.ideaId === ladder.idea.id);
  if (reeval === undefined || ladder.outcome === null) return ladder;
  return { ...ladder, outcome: { ...ladder.outcome, reeval: { vs: reeval.vs, decision: reeval.decision, reason: reeval.reason } } };
}

/**
 * C-256 S5: snapshot 1 is cut after round 1 and merges cleanly at round 2's sync, which re-measures B on the changed
 * tree; snapshot 2 is cut on spend and its round 3 sync holds on a conflict until the owner answers.
 */
const S5_RUN: Pick<ArRunView, "snapshots" | "snapshotPending" | "syncs"> = {
  snapshots: [
    { k: 1, tag: "ar/fixture/s1", sha: KEPT_HEAD, branch: "ar/snapshot/ar-7c1e/1", pr: 101, trigger: "kept", round: 1, logSha: SUPERSEDED_HEAD },
    { k: 2, tag: "ar/fixture/s2", sha: KEPT_HEAD, branch: "ar/snapshot/ar-7c1e/2", pr: 102, url: "https://github.com/example-org/example-target/pull/102", trigger: "spend", round: 2, logSha: SUPERSEDED_HEAD },
  ],
  snapshotPending: null,
  syncs: [
    { round: 2, pr: 101, state: "merged", merged: { from: KEPT_HEAD, to: SYNCED_MAIN, main: SYNCED_MAIN }, treeChanged: true, runs: [evalRun("s1", 231.4), evalRun("s2", 231.1), evalRun("s3", 231.3)] },
    { round: 3, pr: 102, state: "open", conflict: ["src/config.json"], gate: { answered: false } },
  ],
};

/** The synthetic run as the engine records it from C-256 S3a on; every registry row names its idea and round. */
export const AR_RUN_FIXTURE: ArRunView = {
  ...PRE_S3A_RUN,
  ...S5_RUN,
  rounds: PRE_S3A_RUN.rounds.map((plain) => {
    const round = { ...plain, ...S5_ROUNDS[plain.round] };
    return {
      ...round,
      queue: round.queue.map(withDepth),
      planner: PLANNERS[round.round],
      ladders: round.ladders.map((ladder) => withReeval(round, withS3a({ ...ladder, idea: withDepth(ladder.idea) }))),
    };
  }),
  registries: {
    deadEnds: [
      { ideaId: SUPERSEDED.id, round: 1, ...PRE_S3A_RUN.registries.deadEnds[0]! },
      { ideaId: L2_REJECT.id, round: 2, ...PRE_S3A_RUN.registries.deadEnds[1]! },
    ],
    bugs: [{ ideaId: L0_STOP.id, round: 2, ...PRE_S3A_RUN.registries.bugs[0]! }, { round: 2, ...PRE_S3A_RUN.registries.bugs[1]! }],
  },
};

/** The same run under another id, recorded before S3a, so the page proves it still renders a run without those fields. */
export const AR_RUN_PRE_S3A: ArRunView = { ...PRE_S3A_RUN, runId: "ar-2b90" };

const summaryOf = (run: ArRunView, openSnapshot: ArRunSummary["openSnapshot"] = null): ArRunSummary => ({
  runId: run.runId, target: run.target.name, phase: run.target.phases[0]!, round: run.rounds.at(-1)?.round ?? 0, rounds: run.settings.rounds, status: run.status,
  startedAt: run.startedAt, completedAt: run.completedAt, best: run.best, spend: 9.9, openSnapshot,
});

/** Each run's row in `autoresearch.runs`; spend is every implement and eval dollar the run view carries. */
export const AR_RUN_SUMMARY: ArRunSummary = summaryOf(AR_RUN_FIXTURE, { k: 2, pr: 102 });
export const AR_RUN_PRE_S3A_SUMMARY: ArRunSummary = summaryOf(AR_RUN_PRE_S3A);
