import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { TaskSchema, type Task } from '../schemas/task.js';
import { loadBrief, scanExistingTasks } from '../utils/task-seq.js';
import { warn } from './_categories.js';

/*
 * The read side of the owner's rank (TP-5446 plan, F6). Only the owner sets a rank, as a console owner operation, so
 * active-work has no verb that writes one; this lists the ranked tasks of an initiative in rank order.
 */

const RANK_ORDER = ['p0', 'p1', 'p2', 'p3'] as const;

const ArgsSchema = z.object({
  slug: z.string().min(1),
  rank: TaskSchema.shape.rank,
  all: z.boolean().optional(),
});

type Args = z.infer<typeof ArgsSchema>;

const RowSchema = z.object({
  id: z.string(),
  title: z.string(),
  rank: z.enum(RANK_ORDER),
  status: TaskSchema.shape.status,
  priority: z.number(),
});

type Row = z.infer<typeof RowSchema>;

function shown(task: Task, args: Args): task is Task & { rank: Row['rank'] } {
  if (task.rank === undefined) return false;
  if (args.rank !== undefined && task.rank !== args.rank) return false;
  return args.all === true || task.status !== 'done';
}

/** Ranked tasks, p0 first, then by priority within a rank. */
function rankRows(tasks: readonly Task[], args: Args): Row[] {
  return tasks
    .filter((task) => shown(task, args))
    .map(({ id, title, rank, status, priority }) => ({ id, title, rank, status, priority }))
    .sort((a, b) => RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank) || a.priority - b.priority);
}

export default defineCommand<Args, Row[]>({
  name: 'task.rank.show',
  description: "List an initiative's ranked tasks in rank order (p0 first); only the owner sets a rank, from the console",
  args: ArgsSchema,
  result: z.array(RowSchema),
  cli: {
    positional: ['slug'],
    options: {
      rank: { long: '--rank', description: 'Only this rank: p0|p1|p2|p3' },
      all: { long: '--all', description: 'Include done tasks' },
    },
  },
  async run(args, ctx) {
    await loadBrief(args.slug);
    const { tasks, skipped } = await scanExistingTasks(args.slug);
    for (const reason of skipped) warn(ctx, `Skipped a task file that does not validate. ${reason}`);
    return rankRows(tasks, args);
  },
});
