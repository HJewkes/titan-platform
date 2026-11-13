import type { FollowUp } from "@titan-design/review-panel";

/** active-work's task `class` (TP-5446 F1). */
export const TASK_CLASSES = ["product", "upkeep"] as const;
type TaskClass = (typeof TASK_CLASSES)[number];

/**
 * A follow-up's provenance (TP-5446 F3, F4) uses active-work's `task add` argument names: `from_pr` and `from_task` become
 * the task's `source_ref`. `filed_by` is absent on purpose: active-work sets it, and no argument can set it.
 */
export interface FollowUpFields {
  title: string;
  severity: FollowUp["severity"];
  done_when: string;
  tags: string[];
  notes: string;
  source: "follow-up";
  from_pr: string;
  from_task: string;
  class?: TaskClass;
}

/** Active-work's task port as the filer needs it; `add` always files the task as open. */
export interface FollowUpTasks {
  openTasks(initiative: string): Promise<{ id: string; title: string }[]>;
  /** The task's recorded class; undefined when the task is missing or has no class. */
  classOf(initiative: string, id: string): Promise<TaskClass | undefined>;
  add(initiative: string, fields: FollowUpFields): Promise<string>;
  appendNote(initiative: string, id: string, line: string): Promise<void>;
}

export interface FollowUpWhere {
  initiative: string;
  parent: string;
  repo: string;
  pr: number;
  head: string;
  reviewer: string;
}

interface FiledFollowUp {
  title: string;
  id: string;
  deduped: boolean;
}

interface FiledFollowUps {
  filed: FiledFollowUp[];
}

function normalTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

/** A follow-up takes its parent task's recorded class and nothing else, so a parent with no class files one with none. */
function fieldsOf(item: FollowUp, where: FollowUpWhere, parentClass: TaskClass | undefined): FollowUpFields {
  return {
    title: item.title,
    severity: item.severity,
    done_when: item.doneWhen,
    tags: [`follow-up:${where.parent}`],
    notes: `Proposed by reviewer ${where.reviewer} on ${where.repo}#${where.pr} at head ${where.head}. Filed by Shepherd (TP-2498).`,
    source: "follow-up",
    from_pr: `${where.repo}#${where.pr}`,
    from_task: where.parent,
    ...(parentClass && { class: parentClass }),
  };
}

/** The parent is read only when a follow-up is filed, and then only once. */
function once<T>(read: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= read());
}

function linkLine(where: FollowUpWhere, id: string, title: string): string {
  return `Follow-up ${id} filed from ${where.repo}#${where.pr} review at ${where.head.slice(0, 8)}: ${title}`;
}

/**
 * Files each item as an open task unless an open task already has its title, and links every filed or matched id from the
 * parent once. Re-listing on each run makes a re-run after a partial filing land on the ids already filed.
 */
export async function fileFollowUps(tasks: FollowUpTasks, where: FollowUpWhere, items: readonly FollowUp[]): Promise<FiledFollowUps> {
  const open = new Map<string, string>();
  for (const task of await tasks.openTasks(where.initiative)) if (!open.has(normalTitle(task.title))) open.set(normalTitle(task.title), task.id);
  const seen = new Set<string>();
  const filed: FiledFollowUp[] = [];
  const parentClass = once(() => tasks.classOf(where.initiative, where.parent));
  for (const item of items) {
    const key = normalTitle(item.title);
    if (seen.has(key)) continue;
    seen.add(key);
    const existing = open.get(key);
    const id = existing ?? (await tasks.add(where.initiative, fieldsOf(item, where, await parentClass())));
    await tasks.appendNote(where.initiative, where.parent, linkLine(where, id, item.title));
    filed.push({ title: item.title, id, deduped: existing !== undefined });
  }
  return { filed };
}
