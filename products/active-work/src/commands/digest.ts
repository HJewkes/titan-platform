import { z } from 'zod';
import { defineCommand, type CommandContext } from '../registry/index.js';
import { UsageError } from '../errors.js';
import { listSlugsForCaller, withheldSlugs } from '../sessions/visibility.js';
import type { Task } from '../schemas/task.js';
import loops from './loops.js';
import taskList from './task-list.js';

const UPCOMING_DAYS = 14;
const STALE_DAYS = 60;
const STALE_LIMIT = 5;
const MAX_LINES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const ArgsSchema = z.object({
  personal: z.boolean().optional(),
  offline: z.boolean().optional(),
});

const ItemSchema = z.object({
  slug: z.string(),
  id: z.string(),
  title: z.string(),
  date: z.string(),
});

const LoopItemSchema = z.object({ slug: z.string(), ref: z.string(), text: z.string() });

const DigestSchema = z.object({
  date: z.string(),
  overdue: z.array(ItemSchema),
  upcoming: z.array(ItemSchema),
  loops: z.array(LoopItemSchema),
  stale: z.array(ItemSchema),
  /** The rendered listing, at most 30 lines; the arrays above stay whole. */
  lines: z.array(z.string()),
});

// Human mode prints the listing raw, as program.ts does for any string result.
const ResultSchema = z.union([DigestSchema, z.string()]);

type Args = z.infer<typeof ArgsSchema>;
type Digest = z.infer<typeof DigestSchema>;
type Item = z.infer<typeof ItemSchema>;
type LoopItem = z.infer<typeof LoopItemSchema>;
type DatedTask = Task & { slug: string };

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The owner-only initiatives this caller may read. An agent's readable set never holds a withheld
 * initiative, so for it the intersection is empty without the digest reading the caller itself.
 */
async function personalSlugs(ctx: CommandContext): Promise<string[]> {
  const readable = new Set(await listSlugsForCaller(ctx.activeRoot, ctx));
  return (await withheldSlugs(ctx.activeRoot)).filter((slug) => readable.has(slug));
}

async function openTasks(slugs: string[], ctx: CommandContext): Promise<DatedTask[]> {
  const scoped = { ...ctx, format: 'json' as const };
  const all: DatedTask[] = [];
  for (const slug of slugs) {
    const { tasks } = await taskList.run({ slug, sort: 'due' }, scoped);
    all.push(...tasks);
  }
  return all;
}

async function triggerMetLoops(slugs: string[], args: Args, ctx: CommandContext): Promise<LoopItem[]> {
  const items: LoopItem[] = [];
  for (const slug of slugs) {
    const result = await loops.run({ slug, state: 'open', due: true, offline: args.offline }, ctx);
    items.push(...result.open.map((loop) => ({ slug, ref: loop.ref, text: loop.text })));
  }
  return items;
}

function toItem(task: DatedTask, date: string): Item {
  return { slug: task.slug, id: task.id, title: task.title, date };
}

function byDate(a: Item, b: Item): number {
  return a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1;
}

function partition(tasks: DatedTask[], now: number) {
  const today = isoDay(now);
  const horizon = isoDay(now + UPCOMING_DAYS * DAY_MS);
  const staleBefore = isoDay(now - STALE_DAYS * DAY_MS);
  const overdue = tasks.filter((t) => t.due !== undefined && t.due < today);
  const upcoming = tasks.filter((t) => t.due !== undefined && t.due >= today && t.due <= horizon);
  const dated = new Set([...overdue, ...upcoming]);
  const stale = tasks
    .filter((t) => !dated.has(t) && t.updated < staleBefore)
    .map((t) => toItem(t, t.updated))
    .sort(byDate)
    .slice(0, STALE_LIMIT);
  return {
    overdue: overdue.map((t) => toItem(t, t.due ?? '')).sort(byDate),
    upcoming: upcoming.map((t) => toItem(t, t.due ?? '')).sort(byDate),
    stale,
  };
}

function section(title: string, rows: string[]): string[] {
  return [`${title} (${rows.length})`, ...(rows.length > 0 ? rows : ['none']).map((row) => `  ${row}`)];
}

function itemRow(item: Item): string {
  return `${item.date} ${item.slug}/${item.id} ${item.title}`;
}

function capLines(lines: string[]): string[] {
  if (lines.length <= MAX_LINES) return lines;
  const dropped = lines.length - (MAX_LINES - 1);
  const noun = dropped === 1 ? 'line' : 'lines';
  return [...lines.slice(0, MAX_LINES - 1), `... ${dropped} more ${noun} withheld; --json lists every item`];
}

function render(digest: Omit<Digest, 'lines'>): string[] {
  return capLines([
    `Personal digest ${digest.date}`,
    ...section('Overdue', digest.overdue.map(itemRow)),
    ...section(`Due in the next ${UPCOMING_DAYS} days`, digest.upcoming.map(itemRow)),
    ...section('Trigger-met loops', digest.loops.map((loop) => `${loop.slug} ${loop.ref} ${loop.text}`)),
    ...section(`Stale over ${STALE_DAYS} days`, digest.stale.map(itemRow)),
  ]);
}

async function buildDigest(args: Args, ctx: CommandContext): Promise<Digest> {
  const now = Date.now();
  const slugs = await personalSlugs(ctx);
  const sections = partition(await openTasks(slugs, ctx), now);
  const body = { date: isoDay(now), ...sections, loops: await triggerMetLoops(slugs, args, ctx) };
  return { ...body, lines: render(body) };
}

export default defineCommand<Args, z.infer<typeof ResultSchema>>({
  name: 'digest',
  description:
    "The owner's daily digest across owner-only initiatives: overdue tasks, tasks due in the next " +
    `${UPCOMING_DAYS} days, trigger-met loops and the ${STALE_LIMIT} stalest open tasks untouched for ` +
    `${STALE_DAYS} days, in that order and capped at ${MAX_LINES} lines. A caller that may not read ` +
    'owner-only initiatives gets every section empty.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    options: {
      personal: { long: '--personal', description: 'Digest the owner-only initiatives (required)' },
      offline: {
        long: '--offline',
        description: 'Skip the GitHub check for merged PRs; pr loops are then never trigger-met',
      },
    },
    usage: 'active-work digest --personal [--offline]',
  },
  async run(args, ctx) {
    if (args.personal !== true) throw new UsageError('digest needs a scope: pass --personal');
    const digest = await buildDigest(args, ctx);
    return ctx.format === 'human' ? `${digest.lines.join('\n')}\n` : digest;
  },
});
