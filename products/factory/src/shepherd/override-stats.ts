import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { inRange, isoWeek } from "./stats.js";

/**
 * A reviewer verdict that someone else's call overturned. `owner-answer`: an approve-merge gate resolved to anything but
 * merge after a MERGE at that head. `g10-disagree`: a seat reviewer and Shepherd's own review gave opposite verdicts at one head.
 */
export const OwnerOverride = z.object({
  trigger: z.enum(["owner-answer", "g10-disagree"]),
  head: z.string(),
  shepherd: z.enum(["MERGE", "FIX_FIRST"]),
  /** The owner's answer, or the seat reviewer's verdict. */
  other: z.string(),
  at: z.number(),
});
export type OwnerOverride = z.infer<typeof OwnerOverride>;

export interface OverrideRow {
  repo: string;
  /** ISO week of the run's first MERGE verdict, e.g. `2026-W40`. */
  week: string;
  overrides: number;
  mergeRuns: number;
  /** Overrides per run with a MERGE verdict; null when no run in the week had one. */
  rate: number | null;
}

const VERDICT_STEPS = ["sh-await-verdict", "sh-late-verdict"];
const stepName = (key: string): string => key.split(":")[0]!;

const payloadOf = (result: StepResult): Record<string, unknown> => {
  const wrapped = result.data?.result;
  return typeof wrapped === "object" && wrapped !== null ? (wrapped as Record<string, unknown>) : {};
};

const overrideOf = (result: StepResult): OwnerOverride | undefined => {
  const parsed = OwnerOverride.safeParse(payloadOf(result).ownerOverride);
  return parsed.success ? parsed.data : undefined;
};

/** A vetoed MERGE is recorded as the seat's FIX_FIRST, so its override still marks a run whose Shepherd verdict was MERGE. */
function mergeVerdictAt(step: [string, StepResult]): number | undefined {
  const [key, result] = step;
  const payload = payloadOf(result);
  const said = payload.kind === "verdict" && payload.verdict === "MERGE";
  const vetoed = overrideOf(result)?.shepherd === "MERGE";
  return VERDICT_STEPS.includes(stepName(key)) && (said || vetoed) ? Date.parse(result.completedAt) : undefined;
}

/** The overrides a run recorded, from any of its steps. */
export const runOverrides = (run: WorkflowRun): OwnerOverride[] => Object.values(run.stepResults).flatMap((result) => overrideOf(result) ?? []);

/** Per repo and ISO week of a run's first MERGE verdict: the overrides its runs recorded over the runs that had a MERGE verdict. */
export function overrideStats(runs: readonly WorkflowRun[], range: { from?: string; to?: string } = {}): OverrideRow[] {
  const rows = new Map<string, OverrideRow>();
  for (const run of runs) {
    const repo = run.params.repo?.toLowerCase();
    const overrides = runOverrides(run);
    const merges = Object.entries(run.stepResults).flatMap((step) => mergeVerdictAt(step) ?? []);
    const at = merges.length > 0 ? Math.min(...merges) : overrides.length > 0 ? Math.min(...overrides.map((o) => o.at)) : undefined;
    if (!repo || at === undefined || !inRange(at, range)) continue;
    const week = isoWeek(at);
    const row = rows.get(`${repo} ${week}`) ?? { repo, week, overrides: 0, mergeRuns: 0, rate: null };
    rows.set(`${repo} ${week}`, row);
    row.overrides += overrides.length;
    if (merges.length > 0) row.mergeRuns++;
  }
  return [...rows.values()]
    .map((row) => ({ ...row, rate: row.mergeRuns === 0 ? null : Math.round((row.overrides / row.mergeRuns) * 1000) / 1000 }))
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.week.localeCompare(b.week));
}

/** The human lines for `shepherd stats`; empty when no run recorded a MERGE verdict. */
export function overrideLines(rows: readonly OverrideRow[]): string[] {
  if (rows.length === 0) return [];
  const percent = (rate: number | null): string => (rate === null ? "n/a" : `${Math.round(rate * 1000) / 10}%`);
  return ["", "MERGE verdicts overridden:", ...rows.map((r) => `${r.repo}  ${r.week}  overrides ${r.overrides}  runs with MERGE ${r.mergeRuns}  rate ${percent(r.rate)}`)];
}
