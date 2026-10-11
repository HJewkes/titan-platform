import type { WorkflowRun } from "@titan-design/workflow";
import { stageSpans, STAGES } from "./stage-times.js";
import { inRange, mergedAt, outsideAt, stepName, type StatsRange } from "./stats.js";

type Stage = (typeof STAGES)[number];

/** One shepherd-pr run as `shepherd stats --per-run --json` prints it; session-analytics' taskActuals reads this shape. */
export interface PerRunRecord {
  runId: string;
  task: string | null;
  repo: string;
  pr: number | null;
  kind: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  stageMinutes: Partial<Record<Stage, number>>;
  /** Distinct heads among the run's verdict steps, so a retry or correction at one head is one round. */
  reviewRounds: number;
  mergedAt: string | null;
  mergePath: "shepherd" | "outside" | null;
}

const MINUTE = 60_000;
const round = (value: number): number => Math.round(value * 100) / 100;

function stageMinutes(run: WorkflowRun): Partial<Record<Stage, number>> {
  const totals: Partial<Record<Stage, number>> = {};
  for (const span of stageSpans(Object.values(run.stepResults), run.startedAt)) totals[span.stage] = (totals[span.stage] ?? 0) + (span.endedAt - span.startedAt) / MINUTE;
  return Object.fromEntries(STAGES.flatMap((stage) => (totals[stage] === undefined ? [] : [[stage, round(totals[stage])]])));
}

/** The verdict step id is `sh-await-verdict:<head>[:<iter>]`. */
function reviewRounds(run: WorkflowRun): number {
  const heads = Object.values(run.stepResults)
    .filter((result) => stepName(result.stepId) === "sh-await-verdict")
    .map((result) => result.stepId.split(":")[1] ?? "");
  return new Set(heads).size;
}

function mergeOf(run: WorkflowRun): Pick<PerRunRecord, "mergedAt" | "mergePath"> {
  const shepherd = mergedAt(run);
  if (shepherd !== undefined) return { mergedAt: new Date(shepherd).toISOString(), mergePath: "shepherd" };
  const outside = outsideAt(run);
  return outside === undefined ? { mergedAt: null, mergePath: null } : { mergedAt: new Date(outside).toISOString(), mergePath: "outside" };
}

function recordOf(run: WorkflowRun, kinds: ReadonlyMap<string, string>): PerRunRecord {
  const pr = Number(run.params.pr);
  return {
    runId: run.id,
    task: run.params.task || null,
    repo: (run.params.repo ?? "").toLowerCase(),
    pr: pr > 0 ? pr : null,
    kind: kinds.get(run.id) ?? "unknown",
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    stageMinutes: stageMinutes(run),
    reviewRounds: reviewRounds(run),
    ...mergeOf(run),
  };
}

/** One record per run whose start is in range, by start then run id; `kinds` maps a run id to its registration's kind. */
export function perRunExport(runs: readonly WorkflowRun[], kinds: ReadonlyMap<string, string>, range: StatsRange = {}): PerRunRecord[] {
  return runs
    .filter((run) => inRange(Date.parse(run.startedAt), range))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
    .map((run) => recordOf(run, kinds));
}
