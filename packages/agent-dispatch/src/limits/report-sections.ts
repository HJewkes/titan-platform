import type {
  LimitsPoolInput,
  LimitsPoolReading,
  LimitsShepherdInput,
  LimitsWorktreesInput,
} from "./report-input.js";
import type { PoolReport, ShepherdReport, WorktreesReport } from "./report-schema.js";

const MINUTE_MS = 60_000;

const ageMinutes = (readAt: string, now: Date): number =>
  Math.max(0, Math.round((now.getTime() - Date.parse(readAt)) / MINUTE_MS));

const reading = (r: LimitsPoolReading | undefined, now: Date): PoolReport["fiveHour"] =>
  r === undefined ? null : { value: r.value, ageMinutes: ageMinutes(r.readAt, now) };

/** One row per supplied pool, in the order given; readings gain an age against `now`, nothing else is derived. */
export function poolReports(pools: readonly LimitsPoolInput[], now: Date): PoolReport[] {
  return pools.map((p) => ({
    pool: p.pool,
    fiveHour: reading(p.fiveHour, now),
    sevenDay: reading(p.sevenDay, now),
    band: p.band ?? null,
    pace: p.pace ?? null,
    reserve: p.reserve ?? null,
  }));
}

export function worktreesReport(input: LimitsWorktreesInput): WorktreesReport {
  const { active, perRepoPerSeat, totalCeiling, leftFree, budget } = input;
  const repos = Object.fromEntries(
    Object.entries(active).map(([repo, n]) => [repo, { active: n, perRepoPerSeat: perRepoPerSeat ?? null }]),
  );
  return {
    repos,
    ceiling: totalCeiling === undefined ? null : totalCeiling - (leftFree ?? 0),
    budget: budget ?? null,
  };
}

/** A failed Shepherd read becomes `{error}` so the other sections still print; no read at all is null. */
export function shepherdReport(input: LimitsShepherdInput | undefined): ShepherdReport | null {
  if (input === undefined) return null;
  if ("error" in input) return { error: input.error };
  const runs: Record<string, number> = {};
  for (const run of input.runs) runs[run.phase] = (runs[run.phase] ?? 0) + 1;
  return {
    runs,
    held: input.runs.flatMap((r) => (r.holdReason === undefined ? [] : [{ run: r.id, reason: r.holdReason }])),
    reviews: {
      inFlight: input.runs.filter((r) => r.reviewInFlight === true).length,
      maxConcurrent: input.maxConcurrent ?? null,
    },
  };
}
