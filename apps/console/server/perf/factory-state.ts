// A synthetic titan-factory at the size the console's audit measured (TP-4403 §3d): needs, Shepherd's watch list and autoresearch runs.
import type { OwnerItem } from "@titan-design/owner-queue";
import type { ArRunSummary } from "../autoresearch-view.js";
import type { RpcAnswer } from "../test-support.js";
import { draw, isoAt, pad, WORDS, type Draw } from "./random.js";

export const FACTORY_SIZES = { needs: 600, activeRuns: 300, finishedRuns: 2000, autoresearchRuns: 20 } as const;

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
}

export interface FactoryState {
  needs: OwnerItem[];
  active: WatchRow[];
  finished: WatchRow[];
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

export function factoryState(seed: string): FactoryState {
  const random = draw(`${seed}:factory`);
  return {
    needs: Array.from({ length: FACTORY_SIZES.needs }, (_, index) => need(random, index)),
    active: Array.from({ length: FACTORY_SIZES.activeRuns }, (_, index) => watchRow(random, index, ACTIVE_PHASES)),
    finished: Array.from({ length: FACTORY_SIZES.finishedRuns }, (_, index) => watchRow(random, FACTORY_SIZES.activeRuns + index, FINISHED_PHASES)),
    autoresearch: Array.from({ length: FACTORY_SIZES.autoresearchRuns }, (_, index) => autoresearchRun(random, index)),
  };
}

export function factoryAnswer(state: FactoryState): RpcAnswer {
  const lists = { active: state.active, finished: state.finished, all: [...state.active, ...state.finished] };
  return (command, args) => {
    if (command === "needs.list") return { items: state.needs, gaps: [] };
    if (command === "shepherd.list") return lists[(args.state as keyof typeof lists | undefined) ?? "active"] ?? [];
    if (command === "autoresearch.runs") return state.autoresearch;
    throw new Error(`the perf fixture has no factory answer for ${command}`);
  };
}
