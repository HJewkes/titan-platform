import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { planRecordExists } from '../plan/store.js';
import { TaskSchema, type Task } from '../schemas/task.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';

/*
 * One-off backfill of task provenance from an inferred-labels file (TP-5446 plan, section 3.3). Every value it writes
 * is marked `inferred:<heuristic id>` in `field_origin`, so the console can list it for review and a recorded value
 * (origin filed, owner or audit) is never displaced. It writes a field only when the task has no value for it.
 *
 * It deliberately does not go through the S8 dispatch lock (`assertNotRelabel`): a task started before the fields
 * existed has them empty, and an empty field is the only case this verb touches.
 */

export const BACKFILL_FIELDS = ['class', 'serves', 'source', 'done_reason', 'blocked_on'] as const;

type BackfillField = (typeof BACKFILL_FIELDS)[number];

/** The origin used when a row names no heuristic for a field. */
const FALLBACK_HEURISTIC = 'census-2026-11-12';

const LabelValue = z.string().nullable().optional();

const LabelRowSchema = z.object({
  task: z.string().regex(/^[a-z][a-z0-9-]*\/[A-Z][A-Z0-9]*-\d+$/),
  class: LabelValue,
  serves: LabelValue,
  source: LabelValue,
  done_reason: LabelValue,
  blocked_on: LabelValue,
  heuristics: z.record(z.string(), z.string()).optional(),
});

export type LabelRow = z.infer<typeof LabelRowSchema>;

/** The origin marker for a field: the row's heuristic id, cut to the characters `field_origin` allows. */
function inferredOrigin(row: LabelRow, field: BackfillField): string {
  const id = (row.heuristics?.[field] ?? FALLBACK_HEURISTIC)
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `inferred:${id === '' ? FALLBACK_HEURISTIC : id}`;
}

interface RowOutcome {
  next: Task;
  written: BackfillField[];
  skipped: BackfillField[];
}

const isEmpty = (value: unknown): boolean => value === undefined || value === null;

async function fits(activeRoot: string, candidate: Task, field: BackfillField): Promise<boolean> {
  if (!TaskSchema.safeParse(candidate).success) return false;
  if (field !== 'serves' || candidate.serves === undefined || candidate.serves === 'none') return true;
  return planRecordExists(activeRoot, 'outcome', candidate.serves);
}

/** Fills each empty field the row labels; a value that does not fit the schema is skipped, never coerced. */
export async function backfillTask(activeRoot: string, task: Task, row: LabelRow): Promise<RowOutcome> {
  const outcome: RowOutcome = { next: task, written: [], skipped: [] };
  for (const field of BACKFILL_FIELDS) {
    const value = row[field];
    if (isEmpty(value) || !isEmpty(outcome.next[field])) continue;
    const origin = { ...outcome.next.field_origin, [field]: inferredOrigin(row, field) };
    const candidate = { ...outcome.next, [field]: value, field_origin: origin } as Task;
    if (await fits(activeRoot, candidate, field)) {
      outcome.next = candidate;
      outcome.written.push(field);
    } else {
      outcome.skipped.push(field);
    }
  }
  return outcome;
}

/** The task's file: open first, then archived; null when neither exists. */
export async function findTaskFile(initiativeDir: string, id: string): Promise<string | null> {
  for (const dir of [path.join(initiativeDir, 'tasks'), path.join(initiativeDir, 'tasks', 'archive')]) {
    const file = path.join(dir, `${id}.yml`);
    try {
      await fs.access(file);
      return file;
    } catch {
      continue;
    }
  }
  return null;
}

export const readTask = (file: string): Promise<Task> => readYaml(file, TaskSchema);

export const writeTask = (file: string, task: Task): Promise<void> => writeYaml(file, task, TaskSchema);

/** Parses a labels file into one row per task (the last row wins) and counts the lines that are not rows. */
export function parseLabels(text: string): { rows: Map<string, LabelRow>; unreadable: number } {
  const rows = new Map<string, LabelRow>();
  let unreadable = 0;
  for (const line of text.split('\n').filter((l) => l.trim() !== '')) {
    const parsed = parseLine(line);
    if (parsed === null) unreadable += 1;
    else rows.set(parsed.task, parsed);
  }
  return { rows, unreadable };
}

function parseLine(line: string): LabelRow | null {
  try {
    const parsed = LabelRowSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
