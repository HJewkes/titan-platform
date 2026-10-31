import path from 'node:path';
import type { CommandContext } from '../registry/index.js';
import type { Task } from '../schemas/task.js';
import type { RelatedHit, RelatedInput, RelatedResult } from '../search/related.js';
import { scanTasks, type TaskScanSeams } from '../search/task-neighbours.js';
import { taskRef } from '../workspace-index/refs.js';
import { TaskSchema } from '../schemas/task.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { getInitiativeDir, getLockPath } from '../utils/paths.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import { warn } from './_categories.js';

const RELATED_TASK_LIMIT = 3;

// Well under the add's 1 s bound, because the deadline is added to the write.
export const RELATED_DEADLINE_MS = 250;

// From the TP-2544 replay: at 0.9 every flagged pair was a true duplicate, and
// at 0.8 templated titles that differ by one token start to fire.
const POSSIBLE_DUP_THRESHOLD = 0.9;

// A port may return done or foreign hits: `openNeighbours` decides, not the source.
const RELATED_OVERFETCH = 30;

export type RelatedPort = (input: RelatedInput) => Promise<RelatedResult>;

export type TagWriter = (slug: string, taskId: string, tag: string) => Promise<void>;

interface RelatedTaskDeps {
  related?: RelatedPort;
  scan?: TaskScanSeams;
  tagWriter?: TagWriter;
  deadlineMs?: number;
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

function relatedInput(slug: string, task: Task): RelatedInput {
  return {
    text: [task.title, task.done_when].filter(Boolean).join('\n'),
    initiative: slug,
    limit: RELATED_OVERFETCH,
    exclude: [taskRef(task.id)],
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
 * Agents only: humans and /rpc callers never asked for the list.
 *
 * The default scan is synchronous and checks its deadline per task, so it holds
 * the daemon's thread for milliseconds and can never outlast the deadline by more
 * than one task. The timer covers a port that yields instead.
 */
export async function warnRelatedTasks(
  ctx: CommandContext,
  slug: string,
  task: Task,
  existing: Task[],
  deps: RelatedTaskDeps = {},
): Promise<Task> {
  if (ctx.caller !== 'agent') return task;
  const { deadlineMs = RELATED_DEADLINE_MS, scan, tagWriter = writeTag } = deps;
  const open = existing.filter((candidate) => candidate.status === 'open');
  const scanOpen: RelatedPort = (input) =>
    Promise.resolve(scanTasks(input, open, { deadlineMs, ...scan }));
  const { related = scanOpen } = deps;
  try {
    const result = await withinDeadline(related(relatedInput(slug, task)), deadlineMs);
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
