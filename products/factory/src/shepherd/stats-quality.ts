import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { REVERTED_STEP } from "./reverts.js";
import { inRange, isoWeek, payloadOf, type StatsRange } from "./stats.js";

interface RedAfterMergeRow {
  repo: string;
  /** ISO week of the main CI read, which follows its merge within the hour. */
  week: string;
  /** Merged runs that read main CI at their merge. */
  merged: number;
  /** Those whose main CI read was red: defects that escaped review and PR CI. */
  red: number;
  /** `red / merged`, to three places. */
  rate: number;
  redPrs: number[];
  /** Those a later main commit reverted, as the resync pass marked them. */
  reverted: number;
  revertedPrs: number[];
}

/** The run's last sh-main-ci read; a run re-reads main CI only after a crash, and the last read is the one it acted on. */
function lastMainCi(run: WorkflowRun): StepResult | undefined {
  return Object.values(run.stepResults)
    .filter((result) => result.stepId === "sh-main-ci")
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt))
    .at(-1);
}

const prOf = (run: WorkflowRun): number[] => (Number(run.params.pr) > 0 ? [Number(run.params.pr)] : []);

function count(row: RedAfterMergeRow, run: WorkflowRun, red: boolean): void {
  row.merged++;
  if (red) {
    row.red++;
    row.redPrs.push(...prOf(run));
  }
  if (run.stepResults[REVERTED_STEP]) {
    row.reverted++;
    row.revertedPrs.push(...prOf(run));
  }
}

/** Per repo and ISO week: merged runs whose stored sh-main-ci read was red, and those since marked reverted. */
export function redAfterMerge(runs: readonly WorkflowRun[], range: StatsRange = {}): RedAfterMergeRow[] {
  const rows = new Map<string, RedAfterMergeRow>();
  for (const run of runs) {
    const read = lastMainCi(run);
    const repo = run.params.repo?.toLowerCase();
    const at = read && Date.parse(read.completedAt);
    if (!read || !repo || at === undefined || !inRange(at, range)) continue;
    const week = isoWeek(at);
    const row = rows.get(`${repo} ${week}`) ?? { repo, week, merged: 0, red: 0, rate: 0, redPrs: [], reverted: 0, revertedPrs: [] };
    rows.set(`${repo} ${week}`, row);
    count(row, run, payloadOf(read).verdict === "red");
  }
  return [...rows.values()]
    .map((row) => ({ ...row, rate: Math.round((row.red / row.merged) * 1000) / 1000 }))
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.week.localeCompare(b.week));
}

/** The human report's section; empty when no merged run read main CI in range. */
export function formatRedAfterMerge(rows: readonly RedAfterMergeRow[]): string[] {
  const lines = rows.map((r) => `${r.repo}  ${r.week}  merged ${r.merged}  red ${r.red} (${(r.rate * 100).toFixed(1)}%)  reverted ${r.reverted}`);
  return lines.length === 0 ? [] : ["", "red after merge:", ...lines];
}
