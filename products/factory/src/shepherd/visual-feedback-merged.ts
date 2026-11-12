// TP-5409 (gate model S6): the PRs of one repo that Shepherd merged in one ISO week with visual paths changed. Read-only:
// the visual fact is S5's `visualChanged`, recorded on the merge evidence at the merged head, so only async-gate merges count.
import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { MERGE_EVIDENCE_STEP } from "./merge-facts.js";
import { repoKey } from "./round-merge.js";
import { SHEPHERD_WORKFLOW } from "./services.js";

const ISO_WEEK = /^(\d{4})-W(\d{2})$/;
const DAY_MS = 86_400_000;
const MERGE_STEP = /^merge(:r\d+)?:\d+$/;

export interface MergedVisual {
  pr: number;
  headSha: string;
  mergeSha: string;
  mergedAt: string;
  visualChanged: string[];
  /** The tier the evidence measured, as a label only (TP-4320/TP-4761 kept as measurements). */
  tier?: 1 | 2;
  task?: string;
}

/** Monday 00:00 UTC of an ISO week and the Monday after it, in ms; undefined for a malformed week. */
export function isoWeekRange(week: string): { start: number; end: number } | undefined {
  const match = ISO_WEEK.exec(week);
  if (!match) return undefined;
  const jan4 = Date.UTC(Number(match[1]), 0, 4);
  const weekOne = jan4 - (((new Date(jan4).getUTCDay() || 7) - 1) * DAY_MS);
  const start = weekOne + (Number(match[2]) - 1) * 7 * DAY_MS;
  return { start, end: start + 7 * DAY_MS };
}

const MergeDone = z.looseObject({ result: z.looseObject({ done: z.literal(true), mergeSha: z.string().min(1) }) });
const Evidence = z.looseObject({
  result: z.looseObject({
    record: z.looseObject({
      visualChanged: z.array(z.string()).min(1),
      visualTier: z.looseObject({ verdict: z.looseObject({ tier: z.union([z.literal(1), z.literal(2)]) }) }).optional(),
    }),
  }),
});

type Merge = { step: StepResult; mergeSha: string };

/** The run's own landed merge, newest first; a merge made elsewhere names no sha here and is left out. */
function ownMerge(run: WorkflowRun): Merge | undefined {
  const merges = Object.values(run.stepResults).filter((result) => MERGE_STEP.test(result.stepId));
  const done = merges.flatMap((step) => {
    const parsed = MergeDone.safeParse(step.data);
    return parsed.success ? [{ step, mergeSha: parsed.data.result.mergeSha }] : [];
  });
  return done.sort((a, b) => b.step.completedAt.localeCompare(a.step.completedAt))[0];
}

/** The merged head is the newest evidence step completed before the merge; its record says what visual paths changed. */
function evidenceBefore(run: WorkflowRun, mergedAt: string): { head: string; record: z.infer<typeof Evidence>["result"]["record"] } | undefined {
  const prefix = `${MERGE_EVIDENCE_STEP}:`;
  const before = Object.values(run.stepResults).filter((result) => result.stepId.startsWith(prefix) && result.completedAt <= mergedAt);
  const last = before.sort((a, b) => a.completedAt.localeCompare(b.completedAt)).at(-1);
  const parsed = Evidence.safeParse(last?.data);
  return last && parsed.success ? { head: last.stepId.slice(prefix.length), record: parsed.data.result.record } : undefined;
}

function mergedVisualOf(run: WorkflowRun, range: { start: number; end: number }): MergedVisual | undefined {
  const merge = ownMerge(run);
  const at = merge && Date.parse(merge.step.completedAt);
  if (merge === undefined || at === undefined || !(at >= range.start && at < range.end)) return undefined;
  const evidence = evidenceBefore(run, merge.step.completedAt);
  if (evidence === undefined) return undefined;
  const tier = evidence.record.visualTier?.verdict.tier;
  const task = run.params.task;
  const labels = { ...(tier !== undefined && { tier }), ...(task && { task }) };
  return { pr: Number(run.params.pr), headSha: evidence.head, mergeSha: merge.mergeSha, mergedAt: merge.step.completedAt, visualChanged: evidence.record.visualChanged, ...labels };
}

/** One entry per merged PR of `repo` in `week`, lowest PR first; a PR two runs merged keeps its latest merge. */
export function mergedVisualPrs(runs: readonly WorkflowRun[], repo: string, week: string): MergedVisual[] {
  const range = isoWeekRange(week);
  if (range === undefined) return [];
  const byPr = new Map<number, MergedVisual>();
  for (const run of runs) {
    if (run.workflowName !== SHEPHERD_WORKFLOW || repoKey(run.params.repo ?? "") !== repoKey(repo)) continue;
    const merged = mergedVisualOf(run, range);
    const kept = merged && byPr.get(merged.pr);
    if (merged && Number.isInteger(merged.pr) && (!kept || kept.mergedAt < merged.mergedAt)) byPr.set(merged.pr, merged);
  }
  return [...byPr.values()].sort((a, b) => a.pr - b.pr);
}
