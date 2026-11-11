import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { inRange, isoWeek } from "./stats.js";
import { stepPhase, type Phase } from "./step-phase.js";

export const STAGES = ["queued", "ci", "review", "re-review", "hold", "land"] as const;
type Stage = (typeof STAGES)[number];

interface StageSpan {
  stage: Stage;
  startedAt: number;
  endedAt: number;
  /** The phase the run is in now, counted to the injected clock rather than to a step's completion. */
  open?: true;
}

const MINUTE = 60_000;
const round = (value: number): number => Math.round(value * 100) / 100;

/** `post-merge` and the terminal phases are after the PR landed or the run ended, so they belong to no stage. */
const PHASE_STAGE: Partial<Record<Phase, "queued" | "ci" | "review" | "hold" | "land">> = {
  "awaiting-pr": "queued",
  ci: "ci",
  fixing: "ci",
  review: "review",
  "awaiting-approval": "hold",
  merging: "land",
};

/**
 * Stage time from the ledger. A step result records only when it completed, so the time a step took is the gap since the
 * previous completion (or the run's start) and goes to the stage of that step's phase. A review after the run went back
 * through CI or a fixer is a re-review, which covers a head move and a clean merge-up alike. A hold polled inside the
 * merge step leaves no trace in the steps, so it reads as `land`; `watchRow` names a live hold itself.
 */
export function stageSpans(steps: readonly StepResult[], startedAt: string, open?: { phase: Phase; at: number }): StageSpan[] {
  const spans: StageSpan[] = [];
  let leftReview = false;
  const add = (phase: Phase, from: number, to: number, isOpen: boolean): void => {
    const base = PHASE_STAGE[phase];
    if (base === undefined) return;
    if (base === "ci" && spans.some((span) => span.stage === "review")) leftReview = true;
    const stage: Stage = base === "review" && leftReview ? "re-review" : base;
    spans.push({ stage, startedAt: from, endedAt: to, ...(isOpen && { open: true as const }) });
  };
  let cursor = Date.parse(startedAt);
  for (const step of [...steps].sort((a, b) => a.completedAt.localeCompare(b.completedAt))) {
    const done = Date.parse(step.completedAt);
    add(stepPhase(step.stepId), cursor, done, false);
    cursor = done;
  }
  if (open !== undefined) add(open.phase, cursor, Math.max(cursor, open.at), true);
  return spans;
}

interface StageRow {
  stage: Stage;
  /** Runs that spent time in the stage. */
  runs: number;
  medianMinutes: number;
  p90Minutes: number;
  maxMinutes: number;
}

export interface StageWeek {
  repo: string;
  /** ISO week of the run's last recorded step, e.g. `2026-W40`. */
  week: string;
  stages: StageRow[];
}

export function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Nearest rank: the smallest value at or above 90 percent of the sample. */
export const p90 = (sorted: readonly number[]): number => sorted[Math.ceil(sorted.length * 0.9) - 1]!;

function stageRows(perRun: readonly Map<Stage, number>[]): StageRow[] {
  return STAGES.flatMap((stage) => {
    const minutes = perRun.flatMap((totals) => totals.get(stage) ?? []).sort((a, b) => a - b);
    return minutes.length === 0 ? [] : [{ stage, runs: minutes.length, medianMinutes: round(median(minutes)), p90Minutes: round(p90(minutes)), maxMinutes: round(minutes.at(-1)!) }];
  });
}

function totalsOf(spans: readonly StageSpan[]): Map<Stage, number> {
  const totals = new Map<Stage, number>();
  for (const span of spans) totals.set(span.stage, (totals.get(span.stage) ?? 0) + (span.endedAt - span.startedAt) / MINUTE);
  return totals;
}

/** Per repo and ISO week: for each stage, the median, p90 and maximum minutes a run spent in it, summed over the run's visits. Only completed steps count, so a run still in progress adds what it has finished. */
export function stageStats(runs: readonly WorkflowRun[], range: { from?: string; to?: string } = {}): StageWeek[] {
  const groups = new Map<string, { repo: string; week: string; runs: Map<Stage, number>[] }>();
  for (const run of runs) {
    const repo = run.params.repo?.toLowerCase();
    const spans = stageSpans(Object.values(run.stepResults), run.startedAt);
    const last = spans.at(-1);
    if (!repo || last === undefined || !inRange(last.endedAt, range)) continue;
    const week = isoWeek(last.endedAt);
    const group = groups.get(`${repo} ${week}`) ?? { repo, week, runs: [] };
    groups.set(`${repo} ${week}`, group);
    group.runs.push(totalsOf(spans));
  }
  return [...groups.values()].map(({ repo, week, runs: perRun }) => ({ repo, week, stages: stageRows(perRun) })).sort((a, b) => a.repo.localeCompare(b.repo) || a.week.localeCompare(b.week));
}
