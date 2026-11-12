import { isoWeek, quantile, round2 } from "./stats.js";

/** One finished Shepherd run's minutes per stage, as `titan-factory shepherd stats --per-run --json` prints them. */
export interface PhaseRun {
  runId: string;
  /** `owner/name`, lowercase. */
  repo: string;
  /** Null while the run is still going: an open run's stages are not final, so it counts in no week yet. */
  completedAt: string | null;
  stageMinutes: Readonly<Record<string, number>>;
}

/** Median and p90 minutes a finished run spent in one stage, per ISO week of completion (TP-467). */
export interface PhaseWeek {
  isoWeek: string;
  /** A repo, or `all`. */
  repo: string;
  stage: string;
  runs: number;
  medianMinutes: number;
  p90Minutes: number;
}

const ALL = "all";

function phaseOrder(a: PhaseWeek, b: PhaseWeek): number {
  const left = `${a.isoWeek}\u0000${a.repo}\u0000${a.stage}`;
  const right = `${b.isoWeek}\u0000${b.repo}\u0000${b.stage}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

function collect(runs: readonly PhaseRun[]): Map<string, { isoWeek: string; repo: string; stage: string; minutes: number[] }> {
  const cells = new Map<string, { isoWeek: string; repo: string; stage: string; minutes: number[] }>();
  for (const run of [...runs].sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))) {
    if (run.completedAt === null) continue;
    const week = isoWeek(run.completedAt);
    for (const [stage, minutes] of Object.entries(run.stageMinutes)) {
      for (const repo of [ALL, run.repo]) {
        const id = `${week}\u0000${repo}\u0000${stage}`;
        const cell = cells.get(id) ?? { isoWeek: week, repo, stage, minutes: [] };
        cell.minutes.push(minutes);
        cells.set(id, cell);
      }
    }
  }
  return cells;
}

/** Per ISO week, repo and stage over finished runs; the same runs in any order give the same cells. */
export function phaseWeeks(runs: readonly PhaseRun[]): PhaseWeek[] {
  return [...collect(runs).values()]
    .map(({ minutes, ...cell }) => ({
      ...cell,
      runs: minutes.length,
      medianMinutes: round2(quantile(minutes, 0.5) ?? 0),
      p90Minutes: round2(quantile(minutes, 0.9) ?? 0),
    }))
    .sort(phaseOrder);
}
