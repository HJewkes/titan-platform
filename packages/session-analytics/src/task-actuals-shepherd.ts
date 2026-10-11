const MS_PER_HOUR = 3_600_000;

const STAGES = ["queued", "ci", "review", "re-review", "hold", "land"] as const;
type ShepherdStage = (typeof STAGES)[number];
type StageMinutes = Partial<Record<ShepherdStage, number>>;
type MergePath = "shepherd" | "outside";

/** One Shepherd run as `titan-factory shepherd stats --per-run --json` prints it. */
export interface ShepherdRunRecord {
  runId: string;
  /** `<initiative>/<id>`, or null when the run was registered without a task. */
  task: string | null;
  /** `owner/name`, lowercase. */
  repo: string;
  pr: number | null;
  kind: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  stageMinutes: StageMinutes;
  /** Distinct heads the run awaited a verdict on, already deduped within the run. */
  reviewRounds: number;
  mergedAt: string | null;
  mergePath: MergePath | null;
}

/** What a row needs from `taskActuals` to join Shepherd runs onto it. */
interface ShepherdJoinRow {
  taskId: string;
  firstImplAt: string | null;
  prs: readonly { prRef: string; mergedAt: string | null }[];
}

/**
 * The Shepherd facts on a row. Null means unknown, not zero: no joined run, or a merge before
 * Shepherd's ledger began.
 */
export interface ShepherdFacts {
  reviewRounds: number | null;
  stageMinutes: StageMinutes | null;
  /** First implementer request to the earliest merge. */
  serviceWallHours: number | null;
  mergePath: MergePath | null;
}

/** The ledger's coverage start: an explicit `since`, else the earliest run. */
export function shepherdWindowStart(runs: readonly ShepherdRunRecord[], since?: string): string | null {
  if (since !== undefined) return since;
  return runs.map((r) => r.startedAt).sort()[0] ?? null;
}

export function shepherdFactsFor(row: ShepherdJoinRow, runs: readonly ShepherdRunRecord[], windowStart: string | null): ShepherdFacts {
  const joined = runs.filter((run) => joins(run, row));
  const mergeAt = earliest(joined.map((r) => r.mergedAt)) ?? earliest(row.prs.map((p) => p.mergedAt));
  const serviceWallHours = hoursBetween(row.firstImplAt, mergeAt);
  if (mergeAt !== null && windowStart !== null && Date.parse(mergeAt) < Date.parse(windowStart)) {
    return { reviewRounds: null, stageMinutes: null, serviceWallHours, mergePath: null };
  }
  return {
    reviewRounds: joined.length === 0 ? null : joined.reduce((acc, r) => acc + r.reviewRounds, 0),
    stageMinutes: joined.length === 0 ? null : sumStages(joined),
    serviceWallHours,
    mergePath: mergePathOf(joined, row),
  };
}

function joins(run: ShepherdRunRecord, row: ShepherdJoinRow): boolean {
  if (run.task !== null && (run.task === row.taskId || run.task.endsWith(`/${row.taskId}`))) return true;
  if (run.pr === null) return false;
  const ref = `${run.repo}#${run.pr}`.toLowerCase();
  return row.prs.some((p) => p.prRef.toLowerCase() === ref);
}

function mergePathOf(joined: readonly ShepherdRunRecord[], row: ShepherdJoinRow): MergePath | null {
  if (joined.some((r) => r.mergePath === "shepherd")) return "shepherd";
  if (joined.some((r) => r.mergePath === "outside")) return "outside";
  if (joined.length === 0 && row.prs.some((p) => p.mergedAt !== null)) return "outside";
  return null;
}

function sumStages(runs: readonly ShepherdRunRecord[]): StageMinutes {
  const totals: StageMinutes = {};
  for (const run of runs) {
    for (const stage of STAGES) {
      const minutes = run.stageMinutes[stage];
      if (minutes !== undefined) totals[stage] = Math.round(((totals[stage] ?? 0) + minutes) * 100) / 100;
    }
  }
  return totals;
}

function earliest(times: readonly (string | null)[]): string | null {
  const present = times.filter((t): t is string => t !== null);
  return present.length === 0 ? null : present.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
}

function hoursBetween(from: string | null, to: string | null): number | null {
  if (from === null || to === null) return null;
  return (Date.parse(to) - Date.parse(from)) / MS_PER_HOUR;
}
