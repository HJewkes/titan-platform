import type { FollowUp } from "@titan-design/review-panel";

export interface FollowUpFields {
  title: string;
  severity: FollowUp["severity"];
  done_when: string;
  tags: string[];
  notes: string;
}

/** Active-work's task port as the filer needs it; `add` always files the task as open. */
export interface FollowUpTasks {
  openTasks(initiative: string): Promise<{ id: string; title: string }[]>;
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

function fieldsOf(item: FollowUp, where: FollowUpWhere): FollowUpFields {
  return {
    title: item.title,
    severity: item.severity,
    done_when: item.doneWhen,
    tags: [`follow-up:${where.parent}`],
    notes: `Proposed by reviewer ${where.reviewer} on ${where.repo}#${where.pr} at head ${where.head}. Filed by Shepherd (TP-2498).`,
  };
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
  for (const item of items) {
    const key = normalTitle(item.title);
    if (seen.has(key)) continue;
    seen.add(key);
    const existing = open.get(key);
    const id = existing ?? (await tasks.add(where.initiative, fieldsOf(item, where)));
    await tasks.appendNote(where.initiative, where.parent, linkLine(where, id, item.title));
    filed.push({ title: item.title, id, deduped: existing !== undefined });
  }
  return { filed };
}
