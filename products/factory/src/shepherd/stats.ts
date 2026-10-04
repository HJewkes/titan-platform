import type { StepResult, WorkflowRun } from "@titan-design/workflow";

/** A merge that waited longer than this between the reviewer's MERGE and the merge itself is slow. */
const SLOW_WAIT_MS = 60 * 60_000;

interface StatsRange {
  /** Inclusive `YYYY-MM-DD`, UTC. */
  from?: string;
  /** Inclusive `YYYY-MM-DD`, UTC. */
  to?: string;
}

export interface StatsRow {
  repo: string;
  /** ISO week of the merge, e.g. `2026-W40`. */
  week: string;
  merges: number;
  slowMerges: number;
  slowHours: number;
  outsideMerges: number;
}

/** A dispatch step's answer sits under `data.result` in the ledger. */
const payloadOf = (result: StepResult): Record<string, unknown> => {
  const wrapped = result.data?.result;
  return typeof wrapped === "object" && wrapped !== null ? (wrapped as Record<string, unknown>) : {};
};
const stepName = (key: string): string => key.split(":")[0]!;
const MS_PER_DAY = 86_400_000;

/** The ISO 8601 week of a UTC instant: the week belongs to the year of its Thursday. */
export function isoWeek(at: number): string {
  const day = new Date(Math.floor(at / MS_PER_DAY) * MS_PER_DAY);
  const thursday = new Date(day.getTime() + (4 - (day.getUTCDay() || 7)) * MS_PER_DAY);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.floor((thursday.getTime() - yearStart) / (7 * MS_PER_DAY)) + 1;
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** When Shepherd's own `merge` step landed the PR, or undefined if the run did not merge it. */
function mergedAt(run: WorkflowRun): number | undefined {
  const times = Object.entries(run.stepResults)
    .filter(([key, result]) => stepName(key) === "merge" && payloadOf(result).done === true)
    .map(([, result]) => Date.parse(result.completedAt));
  return times.length === 0 ? undefined : Math.min(...times);
}

/** The latest MERGE verdict the reviewer gave before the merge. */
function mergeVerdictAt(run: WorkflowRun, before: number): number | undefined {
  const times = Object.entries(run.stepResults)
    .filter(([key, result]) => stepName(key) === "sh-await-verdict" && payloadOf(result).kind === "verdict" && payloadOf(result).verdict === "MERGE")
    .map(([, result]) => Date.parse(result.completedAt))
    .filter((at) => at <= before);
  return times.length === 0 ? undefined : Math.max(...times);
}

/** The cancel reason ends this way with or without the `landed elsewhere: ` prefix, which the ledger's older runs lack. */
const MERGED_OUTSIDE = /was merged outside Shepherd$/;

const outsideAt = (run: WorkflowRun): number | undefined =>
  run.status === "cancelled" && run.error !== null && MERGED_OUTSIDE.test(run.error) && run.completedAt ? Date.parse(run.completedAt) : undefined;

interface Event {
  repo: string;
  at: number;
  waitMs?: number;
  outside: boolean;
}

function eventOf(run: WorkflowRun): Event | undefined {
  const repo = run.params.repo?.toLowerCase();
  if (!repo) return undefined;
  const merged = mergedAt(run);
  if (merged !== undefined) {
    const verdict = mergeVerdictAt(run, merged);
    return { repo, at: merged, waitMs: verdict === undefined ? undefined : merged - verdict, outside: false };
  }
  const outside = outsideAt(run);
  return outside === undefined ? undefined : { repo, at: outside, outside: true };
}

function inRange(at: number, { from, to }: StatsRange): boolean {
  if (from !== undefined && at < Date.parse(`${from}T00:00:00Z`)) return false;
  return to === undefined || at < Date.parse(`${to}T00:00:00Z`) + MS_PER_DAY;
}

/** Per repo and ISO week: merges, those whose MERGE-to-merged wait exceeded an hour with their total hours, and merges made outside Shepherd. */
export function shepherdStats(runs: readonly WorkflowRun[], range: StatsRange = {}): StatsRow[] {
  const rows = new Map<string, StatsRow>();
  for (const event of runs.flatMap((run) => eventOf(run) ?? [])) {
    if (!inRange(event.at, range)) continue;
    const week = isoWeek(event.at);
    const row = rows.get(`${event.repo} ${week}`) ?? { repo: event.repo, week, merges: 0, slowMerges: 0, slowHours: 0, outsideMerges: 0 };
    rows.set(`${event.repo} ${week}`, row);
    if (event.outside) row.outsideMerges++;
    else row.merges++;
    if (event.waitMs !== undefined && event.waitMs > SLOW_WAIT_MS) {
      row.slowMerges++;
      row.slowHours += event.waitMs / 3_600_000;
    }
  }
  return [...rows.values()].map((row) => ({ ...row, slowHours: Math.round(row.slowHours * 100) / 100 })).sort((a, b) => a.repo.localeCompare(b.repo) || a.week.localeCompare(b.week));
}
