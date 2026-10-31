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
import { warn } from './_categories.js';

const RELATED_TASK_LIMIT = 3;
export const RELATED_DEADLINE_MS = 1000;

// Most hits are done or belong to another initiative, because the initiative is
// a ranking boost and not a filter, so the three that survive sit further down.
const RELATED_OVERFETCH = 30;

export type RelatedPort = (input: RelatedInput) => Promise<RelatedResult>;

interface RelatedTaskDeps {
  related?: RelatedPort;
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
): Promise<void> {
  if (ctx.caller !== 'agent') return;
  const { related = gatedRelated, deadlineMs = RELATED_DEADLINE_MS } = deps;
  try {
    const result = await withinDeadline(related(relatedInput(ctx, slug, task)), deadlineMs);
    if (result === undefined || result.degraded.length > 0) return;
    for (const neighbour of openNeighbours(result.hits, slug, existing)) {
      warn(ctx, `related open task: ${neighbour.id} ${neighbour.title}`);
    }
  } catch {
    // Printing nothing is the whole failure mode of an advisory list.
  }
}
