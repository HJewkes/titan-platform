import path from 'node:path';
import type { CommandContext } from '../registry/index.js';
import type { Task } from '../schemas/task.js';
import {
  relatedContext,
  type RelatedHit,
  type RelatedInput,
  type RelatedResult,
} from '../search/related.js';
import { readerGate } from '../session-index/reader-gate.js';
import { taskRef } from '../workspace-index/refs.js';
import { TaskSchema } from '../schemas/task.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { getInitiativeDir, getLockPath } from '../utils/paths.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import { warn } from './_categories.js';

const RELATED_TASK_LIMIT = 3;
export const RELATED_DEADLINE_MS = 1000;

// From the TP-2544 replay: at 0.9 every flagged pair was a true duplicate, and
// at 0.8 templated titles that differ by one token start to fire.
const POSSIBLE_DUP_THRESHOLD = 0.9;

// Most hits are done or belong to another initiative, because the initiative is
// a ranking boost and not a filter, so the three that survive sit further down.
const RELATED_OVERFETCH = 30;

export type RelatedPort = (input: RelatedInput) => Promise<RelatedResult>;

export type TagWriter = (slug: string, taskId: string, tag: string) => Promise<void>;

interface RelatedTaskDeps {
  related?: RelatedPort;
  tagWriter?: TagWriter;
  deadlineMs?: number;
}

/**
 * No freshness wait: a task add must not stall on the indexer, and a task filed
 * since the last pass is simply not listed. The gate only keeps a daemon refresh
 * pass from spending this read's deadline.
 */
async function gatedRelated(input: RelatedInput): Promise<RelatedResult> {
  const release = readerGate.enter();
  try {
    return await relatedContext(input);
  } finally {
    release();
  }
}

async function withinDeadline<T>(read: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, ms, undefined);
  });
  try {
    return await Promise.race([read, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function relatedInput(ctx: CommandContext, slug: string, task: Task): RelatedInput {
  return {
    text: [task.title, task.done_when].filter(Boolean).join('\n'),
    initiative: slug,
    classes: ['tasks'],
    limit: RELATED_OVERFETCH,
    // Excerpts are never shown here, and a budget would cut before the filter runs.
    budget: Number.POSITIVE_INFINITY,
    exclude: [taskRef(task.id)],
    activeRoot: ctx.activeRoot,
  };
}

/**
 * `existing` decides, not the index: it was read under the lock, so a status is
 * current, and ids repeat across initiatives, so a hit must also name this one.
 */
function openNeighbours(hits: RelatedHit[], slug: string, existing: Task[]): Task[] {
  const open = new Map(existing.filter((t) => t.status === 'open').map((t) => [taskRef(t.id), t]));
  const refs = hits.filter((hit) => hit.initiative === slug).map((hit) => hit.ref);
  return [...new Set(refs)]
    .flatMap((ref) => open.get(ref) ?? [])
    .slice(0, RELATED_TASK_LIMIT);
}

function titleTokens(title: string): Set<string> {
  return new Set(title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

export function titleJaccard(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared++;
  return shared / (ta.size + tb.size - shared);
}

async function writeTag(slug: string, taskId: string, tag: string): Promise<void> {
  await withFileLock(getLockPath(slug), async () => {
    const file = path.join(getInitiativeDir(slug), 'tasks', `${taskId}.yml`);
    const current = await readYaml(file, TaskSchema);
    const tags = current.tags ?? [];
    if (tags.includes(tag)) return;
    await writeYaml(file, { ...current, tags: [...tags, tag] }, TaskSchema);
  });
}

/** Never edits the older task, and a refused write only warns: the task stays filed. */
async function tagPossibleDup(
  ctx: CommandContext,
  slug: string,
  task: Task,
  best: Task | undefined,
  write: TagWriter,
): Promise<Task> {
  if (best === undefined || titleJaccard(task.title, best.title) < POSSIBLE_DUP_THRESHOLD) {
    return task;
  }
  const tag = `possible-dup:${best.id}`;
  try {
    await write(slug, task.id, tag);
    return { ...task, tags: [...(task.tags ?? []), tag] };
  } catch (error) {
    warn(ctx, `could not tag ${task.id} ${tag}: ${error instanceof Error ? error.message : String(error)}`);
    return task;
  }
}

/**
 * Advisory and after the write: the task is already filed, so nothing here may throw.
 *
 * Agents only, because the read costs a median 0.7 to 0.8 s per add on a
 * full-size graph, over the 300 ms a human or /rpc caller would be asked to pay.
 *
 * The search runs synchronously on SQLite, so the deadline cuts a read that
 * yields and cannot stop one mid-query.
 */
export async function warnRelatedTasks(
  ctx: CommandContext,
  slug: string,
  task: Task,
  existing: Task[],
  deps: RelatedTaskDeps = {},
): Promise<Task> {
  if (ctx.caller !== 'agent') return task;
  const { related = gatedRelated, deadlineMs = RELATED_DEADLINE_MS, tagWriter = writeTag } = deps;
  try {
    const result = await withinDeadline(related(relatedInput(ctx, slug, task)), deadlineMs);
    if (result === undefined || result.degraded.length > 0) return task;
    const neighbours = openNeighbours(result.hits, slug, existing);
    for (const neighbour of neighbours) {
      warn(ctx, `related open task: ${neighbour.id} ${neighbour.title}`);
    }
    return await tagPossibleDup(ctx, slug, task, neighbours[0], tagWriter);
  } catch {
    // Printing nothing is the whole failure mode of an advisory list.
    return task;
  }
}
