import type { CommandContext } from '../registry/index.js';
import type { Task } from '../schemas/task.js';
import type { RelatedHit, RelatedInput, RelatedResult } from '../search/related.js';
import { scanTasks, type TaskScanSeams } from '../search/task-neighbours.js';
import { taskRef } from '../workspace-index/refs.js';
import { warn } from './_categories.js';

const RELATED_TASK_LIMIT = 3;

// Well under the add's 1 s bound, because the deadline is added to the write.
export const RELATED_DEADLINE_MS = 250;

// A port may return done or foreign hits: `openNeighbours` decides, not the source.
const RELATED_OVERFETCH = 30;

export type RelatedPort = (input: RelatedInput) => Promise<RelatedResult>;

interface RelatedTaskDeps {
  related?: RelatedPort;
  scan?: TaskScanSeams;
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
): Promise<void> {
  if (ctx.caller !== 'agent') return;
  const { deadlineMs = RELATED_DEADLINE_MS, scan } = deps;
  const open = existing.filter((candidate) => candidate.status === 'open');
  const scanOpen: RelatedPort = (input) =>
    Promise.resolve(scanTasks(input, open, { deadlineMs, ...scan }));
  const { related = scanOpen } = deps;
  try {
    const result = await withinDeadline(related(relatedInput(slug, task)), deadlineMs);
    if (result === undefined || result.degraded.length > 0) return;
    for (const neighbour of openNeighbours(result.hits, slug, existing)) {
      warn(ctx, `related open task: ${neighbour.id} ${neighbour.title}`);
    }
  } catch {
    // Printing nothing is the whole failure mode of an advisory list.
  }
}
