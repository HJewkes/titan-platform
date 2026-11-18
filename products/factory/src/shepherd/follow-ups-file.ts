import type { FollowUp } from "@titan-design/review-panel";
import type { DigestEntry, FollowUpDigest } from "./follow-up-digest.js";

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

/** Where a verdict's follow-ups go: medium and above become tasks, anything lower a digest row (TP-6714). */
export interface FollowUpSinks {
  tasks: FollowUpTasks;
  digest: FollowUpDigest;
}

interface FiledFollowUps {
  filed: FiledFollowUp[];
  /** Titles written to the digest instead of filed. */
  digested: string[];
}

const TASK_SEVERITIES: ReadonlySet<FollowUp["severity"]> = new Set(["medium", "high"]);

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

function digestEntryOf(item: FollowUp, where: FollowUpWhere): DigestEntry {
  return { title: item.title, severity: item.severity, done_when: item.doneWhen, from_pr: `${where.repo}#${where.pr}`, from_task: where.parent, head: where.head, reviewer: where.reviewer };
}

/** The first item of each title, split by severity; a repeat title in one block is dropped whatever its severity. */
function splitBySeverity(items: readonly FollowUp[]): { toFile: FollowUp[]; toDigest: FollowUp[] } {
  const seen = new Set<string>();
  const unique = items.filter((item) => {
    const key = normalTitle(item.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { toFile: unique.filter((item) => TASK_SEVERITIES.has(item.severity)), toDigest: unique.filter((item) => !TASK_SEVERITIES.has(item.severity)) };
}

/**
 * Files each item as an open task unless an open task already has its title, and links every filed or matched id from the
 * parent once. Re-listing on each run makes a re-run after a partial filing land on the ids already filed.
 */
async function fileTasks(tasks: FollowUpTasks, where: FollowUpWhere, items: readonly FollowUp[]): Promise<FiledFollowUp[]> {
  if (items.length === 0) return [];
  const open = new Map<string, string>();
  for (const task of await tasks.openTasks(where.initiative)) if (!open.has(normalTitle(task.title))) open.set(normalTitle(task.title), task.id);
  const filed: FiledFollowUp[] = [];
  const parentClass = once(() => tasks.classOf(where.initiative, where.parent));
  for (const item of items) {
    const existing = open.get(normalTitle(item.title));
    const id = existing ?? (await tasks.add(where.initiative, fieldsOf(item, where, await parentClass())));
    await tasks.appendNote(where.initiative, where.parent, linkLine(where, id, item.title));
    filed.push({ title: item.title, id, deduped: existing !== undefined });
  }
  return filed;
}

/** Medium and above file as tasks; anything lower writes a digest row and touches no task, the parent's notes included. */
export async function fileFollowUps(sinks: FollowUpSinks, where: FollowUpWhere, items: readonly FollowUp[]): Promise<FiledFollowUps> {
  const { toFile, toDigest } = splitBySeverity(items);
  const filed = await fileTasks(sinks.tasks, where, toFile);
  if (toDigest.length > 0) await sinks.digest.append(where.initiative, toDigest.map((item) => digestEntryOf(item, where)));
  return { filed, digested: toDigest.map((item) => item.title) };
}
