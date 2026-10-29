import { z } from "zod";
import { TASK_STAGES, type TaskStage } from "./task-stage.js";
import type { taskRowOf } from "./work.js";

/** What the Tasks board and the home page render of a task; the task page reads the rest. */
export interface TaskListRow {
  slug: string;
  id: string;
  title: string;
  severity?: ReturnType<typeof taskRowOf>["severity"];
  stage: TaskStage;
  stageReason: string;
  /** True for the default rule: nothing was found either way, so the stage is not a verified state. */
  stageGuessed: boolean;
}

/** Filtered here, not in the browser, so a row the per-stage cap leaves out is never one a filter would have shown. */
export const tasksArgs = z.object({
  stage: z.enum(TASK_STAGES).optional(),
  initiative: z.string().min(1).optional(),
  severity: z.string().min(1).optional(),
  /** Matched case-insensitively against the id and title. */
  q: z.string().optional(),
  perStage: z.number().int().min(1).max(1000).optional(),
});

export type TasksArgs = z.infer<typeof tasksArgs>;

export interface TaskListPage {
  /** The matching rows, at most `perStage` of each stage, in the order given. */
  tasks: TaskListRow[];
  /** Every matching row per stage, so a capped stage can say how many it holds. */
  counts: Record<TaskStage, number>;
  /** Each initiative with a row, sorted, whatever the filters. */
  initiatives: string[];
}

/** Thousands of open tasks made a 1.6 MB answer; no board needs more than this many rows of one stage at once. */
const PER_STAGE = 200;

/** Drops every field the board does not render, such as tags, edges and the stage rule. */
export function listRow({ slug, id, title, severity, stage, stageReason, stageGuessed }: TaskListRow): TaskListRow {
  return { slug, id, title, ...(severity !== undefined ? { severity } : {}), stage, stageReason, stageGuessed };
}

export function listPage(rows: readonly TaskListRow[], args: TasksArgs): TaskListPage {
  const perStage = args.perStage ?? PER_STAGE;
  const counts: Record<TaskStage, number> = { blocked: 0, ready: 0, "in-progress": 0, review: 0, done: 0 };
  const tasks = rows.filter(matches(args)).filter((row) => ++counts[row.stage] <= perStage);
  return { tasks, counts, initiatives: [...new Set(rows.map((row) => row.slug))].sort() };
}

function matches({ stage, initiative, severity, q }: TasksArgs): (row: TaskListRow) => boolean {
  const text = q?.toLowerCase();
  return (row) =>
    (!stage || row.stage === stage) &&
    (!initiative || row.slug === initiative) &&
    (!severity || row.severity === severity) &&
    (!text || `${row.id} ${row.title}`.toLowerCase().includes(text));
}
