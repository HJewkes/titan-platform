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

/** Filtered here, not in the browser, so a page holds only rows the filters match and the counts cover every match. */
export const tasksArgs = z.object({
  stage: z.enum(TASK_STAGES).optional(),
  initiative: z.string().min(1).optional(),
  severity: z.string().min(1).optional(),
  /** Matched case-insensitively against the id and title. */
  q: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  /** A previous page's `nextCursor`. */
  cursor: z.string().regex(/^\d+$/).optional(),
});

export type TasksArgs = z.infer<typeof tasksArgs>;

export interface TaskListPage {
  /** At most `limit` matching rows, in the order given, from the cursor on. */
  tasks: TaskListRow[];
  /** Passed back as `cursor` for the next rows; null on the last page. */
  nextCursor: string | null;
  /** Every matching row per stage, so a capped stage can say how many it holds. */
  counts: Record<TaskStage, number>;
  /** Each initiative with a row, sorted, whatever the filters. */
  initiatives: string[];
}

/** Thousands of open tasks made a 1.2 MB answer a phone never finished loading; a page of this many stays under 100 KB. */
const LIMIT = 50;

/** Drops every field the board does not render, such as tags, edges and the stage rule. */
export function listRow({ slug, id, title, severity, stage, stageReason, stageGuessed }: TaskListRow): TaskListRow {
  return { slug, id, title, ...(severity !== undefined ? { severity } : {}), stage, stageReason, stageGuessed };
}

/** The cursor is an offset into the matching rows, so a task that changes stage between pages can repeat or be skipped once. */
export function listPage(rows: readonly TaskListRow[], args: TasksArgs): TaskListPage {
  const counts: Record<TaskStage, number> = { blocked: 0, ready: 0, "in-progress": 0, review: 0, done: 0 };
  const matched = rows.filter(matches(args));
  for (const row of matched) counts[row.stage] += 1;
  const start = Number(args.cursor ?? 0);
  const end = start + (args.limit ?? LIMIT);
  const tasks = matched.slice(start, end);
  return { tasks, nextCursor: end < matched.length ? String(end) : null, counts, initiatives: [...new Set(rows.map((row) => row.slug))].sort() };
}

function matches({ stage, initiative, severity, q }: TasksArgs): (row: TaskListRow) => boolean {
  const text = q?.toLowerCase();
  return (row) =>
    (!stage || row.stage === stage) &&
    (!initiative || row.slug === initiative) &&
    (!severity || row.severity === severity) &&
    (!text || `${row.id} ${row.title}`.toLowerCase().includes(text));
}
