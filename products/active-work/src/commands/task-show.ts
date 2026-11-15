import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { TaskSchema, type Task } from '../schemas/task.js';
import { homesOf, locateTask, type LocatedTask } from '../tasks/locate.js';
import { getActiveRoot, getInitiativeDir } from '../utils/paths.js';
import { NotFoundError, UsageError } from '../errors.js';

const NOTE_TAIL_LINES = 5;
const TASK_KEYS = Object.keys(TaskSchema.shape) as (keyof Task)[];

const ArgsSchema = z.object({
  slug: z.string().min(1),
  id: z.string().min(1).optional(),
  fields: z.string().min(1).optional(),
});

type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = z.union([TaskSchema, z.record(z.string(), z.unknown()), z.string()]);

type Result = z.infer<typeof ResultSchema>;

/** Accepts `<slug> <id>` and the `<slug>/<id>` form agents reach for first. */
function resolveTarget(args: Args): { slug: string; id: string } {
  if (args.id !== undefined) return { slug: args.slug, id: args.id };
  const cut = args.slug.lastIndexOf('/');
  if (cut <= 0 || cut === args.slug.length - 1) {
    throw new UsageError('task.show requires <slug> <id> or <slug>/<id>');
  }
  return { slug: args.slug.slice(0, cut), id: args.slug.slice(cut + 1) };
}

function parseFields(raw: string): (keyof Task)[] {
  const fields = raw
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  const unknown = fields.filter((f) => !(TASK_KEYS as string[]).includes(f));
  if (unknown.length > 0) {
    throw new UsageError(
      `Unknown task field(s): ${unknown.join(', ')}; valid: ${TASK_KEYS.join(', ')}`,
    );
  }
  return fields as (keyof Task)[];
}

async function assertInitiative(slug: string): Promise<void> {
  const stat = await fs.stat(getInitiativeDir(slug)).catch(() => null);
  if (!stat?.isDirectory()) throw new NotFoundError(`Initiative not found: ${slug}`);
}

async function notFoundHint(slug: string, id: string): Promise<string> {
  const homes = (await homesOf(id)).filter((home) => home !== slug);
  if (homes.length === 0) return '';
  return `; filed in ${homes.join(', ')} (task show ${homes[0]} ${id})`;
}

async function readTask(slug: string, id: string): Promise<LocatedTask> {
  await assertInitiative(slug);
  const message = `task ${id} not found in ${slug}`;
  // The id becomes a filename, so anything that is not a task id is simply absent.
  if (!TaskSchema.shape.id.safeParse(id).success) throw new NotFoundError(message);
  const located = await locateTask(slug, id);
  if (!located) throw new NotFoundError(message + (await notFoundHint(slug, id)));
  return located;
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function noteTail(notes: string): string[] {
  const lines = notes.split('\n').filter((line) => line.trim().length > 0);
  return lines.slice(-NOTE_TAIL_LINES);
}

const COMPACT_KEYS: (keyof Task)[] = [
  'id',
  'title',
  'status',
  'priority',
  'severity',
  'estimate',
  'due',
  'kind',
  'cos',
  'area',
  'parent',
  'dep',
  'bet',
  'tags',
  'done_when',
  'done_at',
  'done_reason',
];

function renderCompact({ task, archived }: LocatedTask): string {
  const lines = COMPACT_KEYS.filter((key) => task[key] !== undefined && task[key] !== null)
    .map((key) => `${key}: ${formatValue(task[key])}`);
  if (archived) lines.push('archived: yes');
  if (task.notes) {
    lines.push(
      `notes (last ${NOTE_TAIL_LINES} lines):`,
      ...noteTail(task.notes).map((l) => `  ${l}`),
    );
  }
  return lines.join('\n') + '\n';
}

function pick(task: Task, fields: (keyof Task)[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((key) => [key, task[key] ?? null]));
}

export default defineCommand<Args, Result>({
  name: 'task.show',
  description: 'Show one task: task show <slug> <id>, or <slug>/<id>',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug', 'id'],
    options: {
      fields: {
        long: '--fields',
        description: 'Comma-separated keys to print, e.g. id,status,done_when,notes',
      },
    },
  },
  async run(args, ctx) {
    getActiveRoot();
    const { slug, id } = resolveTarget(args);
    const fields = args.fields === undefined ? undefined : parseFields(args.fields);
    const located = await readTask(slug, id);
    const { task } = located;
    if (fields === undefined) return ctx.format === 'json' ? task : renderCompact(located);
    const picked = pick(task, fields);
    if (ctx.format === 'json') return picked;
    return fields.map((key) => `${key}: ${formatValue(picked[key])}`).join('\n') + '\n';
  },
});
