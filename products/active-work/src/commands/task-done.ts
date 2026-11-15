import path from 'node:path';
import { z } from 'zod';
import { readEdges } from '@titan-design/pm';
import { defineCommand, type CommandContext } from '../registry/index.js';
import { visibilityFor } from '../sessions/visibility.js';
import { createDepFinder, openDeps } from '../tasks/blockers.js';
import { closedStatusIds } from './_categories.js';
import taskList from './task-list.js';
import { TaskSchema, type Task } from '../schemas/task.js';
import { getActiveRoot, getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import { nowIso, today } from '../utils/today.js';
import { NotFoundError } from '../errors.js';
import { filedOrigins } from './_task-provenance.js';
import {
  quietOption,
  QuietArg,
  TaskOrLineSchema,
  quietOr,
  type TaskOrLine,
} from './_task-quiet.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  id: z.string().min(1),
  reason: TaskSchema.shape.done_reason,
  quiet: QuietArg,
});

type Args = z.infer<typeof ArgsSchema>;

/** The closer's reason, marked as filed; closing without one keeps whatever the task carried. */
function doneReason(task: Task, reason: Args['reason']): Partial<Task> {
  if (reason === undefined) return {};
  return { done_reason: reason, field_origin: filedOrigins(task.field_origin, ['done_reason']) };
}

interface Unblocked {
  named: string[];
  hidden: number;
}

/**
 * The open tasks, in any initiative, whose last open dep was `done`. The scan reuses task.list's
 * parse cache; an initiative the caller may not see is counted so its ids do not leak.
 */
async function findUnblocked(done: Task, ctx: CommandContext): Promise<Unblocked> {
  const activeRoot = getActiveRoot();
  const everything = { ...ctx, caller: 'owner' as const, warnings: [] };
  const { tasks } = await taskList.run({ all_initiatives: true, status: 'open' }, everything);
  const shown = await visibilityFor({ activeRoot, caller: ctx.caller, warnings: [] });
  const lookup = { closed: await closedStatusIds(activeRoot), find: createDepFinder(activeRoot) };
  const result: Unblocked = { named: [], hidden: 0 };
  for (const task of tasks) {
    if (task.id === done.id || !readEdges(task).dep.includes(done.id)) continue;
    if ((await openDeps(task, lookup)).length > 0) continue;
    if (shown(task.slug)) result.named.push(task.id);
    else result.hidden += 1;
  }
  return result;
}

function describeUnblocked({ named, hidden }: Unblocked): string {
  return hidden > 0 ? [...named, `${hidden} hidden`].join(', ') : named.join(', ');
}

async function reportUnblocked(done: Task, ctx: CommandContext): Promise<string> {
  const unblocked = await findUnblocked(done, ctx);
  if (unblocked.named.length + unblocked.hidden === 0) return '';
  const names = describeUnblocked(unblocked);
  ctx.warnings.push(`completing ${done.id} unblocks ${names}`);
  return ` (unblocks ${names})`;
}

export default defineCommand<Args, TaskOrLine>({
  name: 'task.done',
  description: 'Mark a task as done',
  args: ArgsSchema,
  result: TaskOrLineSchema,
  cli: {
    positional: ['slug', 'id'],
    options: {
      reason: { long: '--reason', description: 'Why it closed: shipped|superseded|duplicate|moot|wont-do' },
      quiet: quietOption('PRJ-12 done 2026-10-04'),
    },
  },
  async run(args, ctx) {
    getActiveRoot();
    const updated = await withFileLock(getLockPath(args.slug), async () => {
      const file = path.join(getInitiativeDir(args.slug), 'tasks', `${args.id}.yml`);
      let task: Task;
      try {
        task = await readYaml(file, TaskSchema);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new NotFoundError(`Task not found: ${args.id}`);
        }
        throw err;
      }
      const date = today();
      const updated: Task = {
        ...task,
        status: 'done',
        done_at: nowIso(),
        updated: date,
        ...doneReason(task, args.reason),
      };
      await writeYaml(file, updated, TaskSchema);
      return updated;
    });
    const suffix = await reportUnblocked(updated, ctx);
    return quietOr(args.quiet, ctx, updated, () => `${updated.id} done ${updated.updated}${suffix}`);
  },
});
