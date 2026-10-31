// A synthetic titan-factory at the size the console's audit measured (TP-4403 §3d): needs, Shepherd's watch list and autoresearch runs.
import type { OwnerItem } from "@titan-design/owner-queue";
import type { ArRunSummary } from "../autoresearch-view.js";
import type { RpcAnswer } from "../test-support.js";
import { dayWindow } from "../coord-day.js";
import { draw, isoAt, pad, WORDS, type Draw } from "./random.fixture.js";

export const FACTORY_SIZES = { needs: 600, activeRuns: 300, finishedRuns: 2000, autoresearchRuns: 20 } as const;
/** Runs merged inside the coordinator day the coord budget rows read (`BUDGET_DAY`), as a busy day has them. */
export const MERGED_ON_BUDGET_DAY = 80;
export const BUDGET_DAY = "2031-01-01";

const NEED_SOURCES = [
  { system: "agent-chat", id: "chat" },
  { system: "hitl", id: "hitl" },
  { system: "morning", id: "morning" },
  { system: "active-work", id: "task" },
] as const;
const LENSES = ["blocking-agent", "blocking-merge", "stuck", "planning", "fyi"] as const;
const KINDS = ["decide", "approve", "do", "review", "know"] as const;
const ACTIVE_PHASES = ["awaiting-ci", "awaiting-review", "fixing", "awaiting-approval", "landing"] as const;
const FINISHED_PHASES = ["merged", "closed", "abandoned"] as const;
const AR_STATUSES = ["running", "paused", "completed", "failed", "cancelled"] as const;

/** Rows carry a fixed extra field, as Shepherd's do, so the console's passthrough keeps paying for fields it never shows. */
export interface WatchRow {
  repo: string;
  pr: number;
  branch: string;
  runId: string;
  task: string;
  phase: string;
  headSha: string;
  phaseSince: string;
  nextAction: string;
  pendingGate: { gateId: string; stepId: string; since: string } | null;
  held: { reason: string } | null;
  stalled: { reason: string } | null;
  stepResults: string[];
  outcome?: { kind: string; reason: null };
}

export interface MergedRun {
  row: WatchRow;
  landedAt: string;
}

export interface FactoryState {
  needs: OwnerItem[];
  active: WatchRow[];
  finished: WatchRow[];
  /** Merged runs whose phase flipped after their merge, inside the budget day; kept apart so `finished` stays at its size. */
  mergedOnBudgetDay: MergedRun[];
  autoresearch: ArRunSummary[];
}

const sha = (random: Draw): string => Array.from({ length: 40 }, () => "0123456789abcdef"[random.int(16)]).join("");

function need(random: Draw, index: number): OwnerItem {
  const source = random.pick(NEED_SOURCES);
  const ref = `${source.id}-${pad(index)}`;
  return {
    id: `${source.id}:${ref}`,
    sources: [{ system: source.system, ref }],
    kind: random.pick(KINDS),
    door: random.chance(0.1) ? "one-way" : "two-way",
    summary: `Synthetic ${source.id} need ${index}: ${random.pick(WORDS)} ${random.pick(WORDS)}`,
    context: "Synthetic context. ".repeat(1 + random.int(12)),
    keys: [`need:${ref}`],
    asker: `seat-${random.int(12)}`,
    personal: false,
    lens: random.pick(LENSES),
    unblocks: [],
    openedAt: isoAt(-random.int(2000)),
    status: "open",
  };
}

function watchRow(random: Draw, index: number, phases: readonly string[]): WatchRow {
  const pr = 1000 + index;
  const runId = `run-${pad(index, 5)}`;
  const phase = random.pick(phases);
  const since = isoAt(-random.int(3000));
  const gated = phase === "awaiting-approval";
  return {
    repo: `example-org/repo-${pad(random.int(30), 2)}`,
    pr,
    branch: `feat/synthetic-${pr}`,
    runId,
    task: `example/EX-${index}`,
    phase,
    headSha: sha(random),
    phaseSince: since,
    nextAction: gated ? "owner: resolve approve-merge" : `wait: ${phase}`,
    pendingGate: gated ? { gateId: `${runId}/approve-merge`, stepId: "approve-merge", since } : null,
    held: random.chance(0.05) ? { reason: "owner-asked: wait" } : null,
    stalled: random.chance(0.05) ? { reason: "no CI for 6 h" } : null,
    stepResults: Array.from({ length: 3 + random.int(6) }, (_, step) => `step ${step}: ok`),
  };
}

const MINUTE_MS = 60_000;
const PHASE_TRAIL_MIN = 40;

/** Built from the local-time window, so the day holds them in any timezone; no draw, so the other rows keep their values. */
function mergedOnBudgetDay(): MergedRun[] {
  const { from } = dayWindow(Date.parse(`${BUDGET_DAY}T12:00:00`), "07:00", BUDGET_DAY);
  return Array.from({ length: MERGED_ON_BUDGET_DAY }, (_, index) => {
    const pr = 9000 + index;
    const phaseSince = new Date(from + (60 + index * 5) * MINUTE_MS);
    const row: WatchRow = {
      repo: "example-org/repo-00", pr, branch: `feat/merged-${pr}`, runId: `run-merged-${pad(index, 3)}`, task: `example/EX-${pr}`, phase: "done",
      headSha: "0".repeat(40), phaseSince: phaseSince.toISOString(), nextAction: "none", pendingGate: null, held: null, stalled: null,
      stepResults: ["step 0: ok"], outcome: { kind: "merged", reason: null },
    };
    return { row, landedAt: new Date(phaseSince.getTime() - PHASE_TRAIL_MIN * MINUTE_MS).toISOString() };
  });
}

function autoresearchRun(random: Draw, index: number): ArRunSummary {
  const status = random.pick(AR_STATUSES);
  const rounds = 4 + random.int(8);
  return {
    runId: `ar-${pad(index, 3)}`,
    target: `packages/${random.pick(WORDS)}`,
    phase: status === "running" ? "implement" : "done",
    round: random.int(rounds),
    rounds,
    status,
    startedAt: isoAt(-random.int(2000)),
    completedAt: status === "running" || status === "paused" ? null : isoAt(-random.int(100)),
    best: random.chance(0.6) ? { head: sha(random), primary: random.int(1000) / 10 } : null,
    spend: random.int(5000) / 100,
    openSnapshot: null,
  };
}

/** Every other fixture time is after the real clock, so one gate is dated in its past for `blockers.banner` to list. */
export const OLD_GATE_SINCE = "2001-01-01T00:00:00.000Z";

function withOldOwnerGate(rows: WatchRow[]): WatchRow[] {
  const first = rows.findIndex((row) => row.pendingGate !== null);
  return rows.map((row, index) => (index === first && row.pendingGate !== null ? { ...row, pendingGate: { ...row.pendingGate, since: OLD_GATE_SINCE } } : row));
}

export function factoryState(seed: string): FactoryState {
  const random = draw(`${seed}:factory`);
  return {
    needs: Array.from({ length: FACTORY_SIZES.needs }, (_, index) => need(random, index)),
    active: withOldOwnerGate(Array.from({ length: FACTORY_SIZES.activeRuns }, (_, index) => watchRow(random, index, ACTIVE_PHASES))),
    finished: Array.from({ length: FACTORY_SIZES.finishedRuns }, (_, index) => watchRow(random, FACTORY_SIZES.activeRuns + index, FINISHED_PHASES)),
    mergedOnBudgetDay: mergedOnBudgetDay(),
    autoresearch: Array.from({ length: FACTORY_SIZES.autoresearchRuns }, (_, index) => autoresearchRun(random, index)),
  };
}

export function factoryAnswer(state: FactoryState): RpcAnswer {
  const finished = [...state.finished, ...state.mergedOnBudgetDay.map(({ row }) => row)];
  const lists = { active: state.active, finished, all: [...state.active, ...finished] };
  return (command, args) => {
    if (command === "needs.list") return { items: state.needs, gaps: [] };
    if (command === "shepherd.list") return lists[args.state === "finished" || args.state === "all" ? args.state : "active"];
    if (command === "shepherd.timeline") return timelineOf(state, args);
    if (command === "autoresearch.runs") return state.autoresearch;
    throw new Error(`the perf fixture has no factory answer for ${command}`);
  };
}

/** Only the merged runs have a timeline here; any other PR is a read the fixture cannot answer. */
function timelineOf(state: FactoryState, args: Record<string, unknown>) {
  const run = state.mergedOnBudgetDay.find(({ row }) => row.repo === args.repo && row.pr === args.pr);
  if (run === undefined) throw new Error("the perf fixture has no timeline for that PR");
  return { row: run.row, entries: [{ kind: "step", stepId: "sh-landed", iteration: 0, startedAt: null, completedAt: run.landedAt, signal: null, status: "done" }] };
}
