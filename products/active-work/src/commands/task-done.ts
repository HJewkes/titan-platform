import path from 'node:path';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
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
    return withFileLock(getLockPath(args.slug), async () => {
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
      return quietOr(args.quiet, ctx, updated, () => `${updated.id} done ${date}`);
    });
  },
});
