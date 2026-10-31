import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { isObjectLike } from "@titan-design/rpc-protocol/narrow";

/** A merge that waited longer than this between the reviewer's MERGE and the merge itself is slow. */
const SLOW_WAIT_MS = 60 * 60_000;

export interface StatsRange {
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
  /** Shepherd's own update-branch steps, by why each ran. */
  mergeUps: MergeUps;
  /** `land-rules` reads that found the repo requiring up-to-date heads: each one starts the strict chase. */
  strictRounds: number;
  /** Slow merges whose wait held an owner `approve-merge` gate. */
  slowOwnerGated: number;
  /** Merges of the base pushed by someone other than Shepherd. */
  foreignMergeUps: number;
}

interface MergeUps {
  landTime: number;
  strictChase: number;
  freezeHold: number;
  baseRed: number;
  retry: number;
}

/** A dispatch step's answer sits under `data.result` in the ledger. */
export const payloadOf = (result: StepResult): Record<string, unknown> => {
  const wrapped = result.data?.result;
  return isObjectLike(wrapped) ? wrapped : {};
};
export const stepName = (key: string): string => key.split(":")[0]!;
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
export function mergedAt(run: WorkflowRun): number | undefined {
  const times = Object.entries(run.stepResults)
    .filter(([key, result]) => stepName(key) === "merge" && payloadOf(result).done === true)
    .map(([, result]) => Date.parse(result.completedAt));
  return times.length === 0 ? undefined : Math.min(...times);
}

/** The latest MERGE verdict the reviewer gave before the merge. */
export function mergeVerdictAt(run: WorkflowRun, before: number): number | undefined {
  const times = Object.entries(run.stepResults)
    .filter(([key, result]) => stepName(key) === "sh-await-verdict" && payloadOf(result).kind === "verdict" && payloadOf(result).verdict === "MERGE")
    .map(([, result]) => Date.parse(result.completedAt))
    .filter((at) => at <= before);
  return times.length === 0 ? undefined : Math.max(...times);
}

/** The cancel reason ends this way with or without the `landed elsewhere: ` prefix, which the ledger's older runs lack. */
const MERGED_OUTSIDE = /was merged outside Shepherd$/;

export const outsideAt = (run: WorkflowRun): number | undefined =>
  run.status === "cancelled" && run.error !== null && MERGED_OUTSIDE.test(run.error) && run.completedAt ? Date.parse(run.completedAt) : undefined;

interface Event {
  repo: string;
  at: number;
  waitMs?: number;
  ownerGated: boolean;
  outside: boolean;
}

/** True when an owner `approve-merge` gate resolved inside the MERGE-to-merged wait, so the owner held the merge. */
function ownerGatedBetween(run: WorkflowRun, verdictAt: number, merged: number): boolean {
  return Object.entries(run.stepResults).some(([key, result]) => {
    const at = Date.parse(result.completedAt);
    return stepName(key) === "approve-merge" && at > verdictAt && at <= merged;
  });
}

function eventOf(run: WorkflowRun): Event | undefined {
  const repo = run.params.repo?.toLowerCase();
  if (!repo) return undefined;
  const merged = mergedAt(run);
  if (merged !== undefined) {
    const verdict = mergeVerdictAt(run, merged);
    const ownerGated = verdict !== undefined && ownerGatedBetween(run, verdict, merged);
    return { repo, at: merged, waitMs: verdict === undefined ? undefined : merged - verdict, ownerGated, outside: false };
  }
  const outside = outsideAt(run);
  return outside === undefined ? undefined : { repo, at: outside, ownerGated: false, outside: true };
}

type MergeUpClass = keyof MergeUps;

interface Ordered {
  key: string;
  result: StepResult;
}

export const inStepOrder = (run: WorkflowRun): Ordered[] =>
  Object.entries(run.stepResults)
    .map(([key, result]) => ({ key, result }))
    .sort((a, b) => a.result.completedAt.localeCompare(b.result.completedAt));

/** The head the run's newest CI read was at, which is the head its merge step merges; undefined before any. */
export function lastCiHead(run: WorkflowRun): string | undefined {
  const read = inStepOrder(run)
    .filter(({ key }) => stepName(key) === "ci-wait")
    .at(-1);
  const head = read && payloadOf(read.result).headSha;
  return typeof head === "string" ? head : undefined;
}

const FREEZE_HOLD_UPDATE = "update-branch:sh-freeze-hold:";

/**
 * Classifies one update-branch step by what preceded it. A freeze-hold refresh whose round waited on a red base is the
 * base-red refresh; it is matched by round number, not step order, because the wait and the update can share a timestamp.
 * A refresh after a `ci-wait` read that saw the base move past a green is the land-time merge-up; any other update off a
 * behind read is the strict chase.
 */
function classOf(run: WorkflowRun, key: string, previous: string | undefined, lastCi: Record<string, unknown> | undefined): MergeUpClass {
  if (key.startsWith(FREEZE_HOLD_UPDATE)) return `sh-base-wait:${key.slice(FREEZE_HOLD_UPDATE.length)}` in run.stepResults ? "baseRed" : "freezeHold";
  if (previous !== undefined && stepName(previous) === "update-backoff") return "retry";
  return lastCi?.baseMoved === true ? "landTime" : "strictChase";
}

/** Each of Shepherd's own update-branch steps in step order, with its class and when it completed. */
function mergeUpsOf(run: WorkflowRun): { kind: MergeUpClass; at: number }[] {
  const ups: { kind: MergeUpClass; at: number }[] = [];
  let previous: string | undefined;
  let lastCi: Record<string, unknown> | undefined;
  for (const { key, result } of inStepOrder(run)) {
    if (stepName(key) === "ci-wait") lastCi = payloadOf(result);
    if (stepName(key) === "update-branch") ups.push({ kind: classOf(run, key, previous, lastCi), at: Date.parse(result.completedAt) });
    previous = key;
  }
  return ups;
}

/** When each `land-rules` read that found the repo strict completed. */
function strictRoundsOf(run: WorkflowRun): number[] {
  return Object.entries(run.stepResults)
    .filter(([key, result]) => stepName(key) === "land-rules" && payloadOf(result).strict === true)
    .map(([, result]) => Date.parse(result.completedAt));
}

export function inRange(at: number, { from, to }: StatsRange): boolean {
  if (from !== undefined && at < Date.parse(`${from}T00:00:00Z`)) return false;
  return to === undefined || at < Date.parse(`${to}T00:00:00Z`) + MS_PER_DAY;
}

const emptyRow = (repo: string, week: string): StatsRow => ({
  repo,
  week,
  merges: 0,
  slowMerges: 0,
  slowHours: 0,
  outsideMerges: 0,
  mergeUps: { landTime: 0, strictChase: 0, freezeHold: 0, baseRed: 0, retry: 0 },
  strictRounds: 0,
  slowOwnerGated: 0,
  foreignMergeUps: 0,
});

class Rows {
  private readonly rows = new Map<string, StatsRow>();
  constructor(private readonly range: StatsRange) {}

  /** The row an instant counts toward, or undefined when it falls outside the range. */
  at(repo: string, at: number): StatsRow | undefined {
    if (!inRange(at, this.range)) return undefined;
    const week = isoWeek(at);
    const row = this.rows.get(`${repo} ${week}`) ?? emptyRow(repo, week);
    this.rows.set(`${repo} ${week}`, row);
    return row;
  }

  sorted(): StatsRow[] {
    return [...this.rows.values()].map((row) => ({ ...row, slowHours: Math.round(row.slowHours * 100) / 100 })).sort((a, b) => a.repo.localeCompare(b.repo) || a.week.localeCompare(b.week));
  }
}

function addEvent(rows: Rows, event: Event): void {
  const row = rows.at(event.repo, event.at);
  if (!row) return;
  if (event.outside) row.outsideMerges++;
  else row.merges++;
  if (event.waitMs === undefined || event.waitMs <= SLOW_WAIT_MS) return;
  row.slowMerges++;
  row.slowHours += event.waitMs / 3_600_000;
  if (event.ownerGated) row.slowOwnerGated++;
}

/** When each `sh-head-origin` read found a merge of the base that someone other than Shepherd pushed. */
function foreignMergeUpsOf(run: WorkflowRun): number[] {
  return Object.entries(run.stepResults)
    .filter(([key, result]) => stepName(key) === "sh-head-origin" && payloadOf(result).kind === "merge-of-base")
    .map(([, result]) => Date.parse(result.completedAt));
}

/** A merged run's merge-ups count in its merge week, so they sit beside the wait they caused; others in their own week. */
function addMergeUps(rows: Rows, run: WorkflowRun): void {
  const repo = run.params.repo?.toLowerCase();
  if (!repo) return;
  const merged = mergedAt(run);
  for (const up of mergeUpsOf(run)) {
    const row = rows.at(repo, merged ?? up.at);
    if (row) row.mergeUps[up.kind]++;
  }
  for (const at of strictRoundsOf(run)) {
    const row = rows.at(repo, merged ?? at);
    if (row) row.strictRounds++;
  }
  for (const at of foreignMergeUpsOf(run)) {
    const row = rows.at(repo, merged ?? at);
    if (row) row.foreignMergeUps++;
  }
}

/**
 * Per repo and ISO week: merges, those whose MERGE-to-merged wait exceeded an hour with their total hours and how many
 * an owner gate held, merges made outside Shepherd, Shepherd's merge-ups by class with the strict rounds behind them, and
 * the merges of the base that others pushed.
 */
export function shepherdStats(runs: readonly WorkflowRun[], range: StatsRange = {}): StatsRow[] {
  const rows = new Rows(range);
  for (const run of runs) {
    const event = eventOf(run);
    if (event) addEvent(rows, event);
    addMergeUps(rows, run);
  }
  return rows.sorted();
}
