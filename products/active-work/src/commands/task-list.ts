import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { TaskSchema, type Task } from '../schemas/task.js';
import { getActiveRoot, getInitiativeDir } from '../utils/paths.js';
import { mapConcurrent } from '../utils/map-concurrent.js';
import { readYaml } from '../utils/yaml-io.js';
import { UsageError } from '../errors.js';
import { listSlugsForCaller } from '../sessions/visibility.js';
import { createDepFinder, openDeps } from '../tasks/blockers.js';
import { closedStatusIds, loadCategoryRegistry } from './_categories.js';

// No schema default: buildFilter picks it, because the default depends on --id. The values a root
// accepts depend on its category registry, so run() checks them, not the schema.
const StatusFilter = z.string().min(1);

const BUILT_IN_STATUS_IDS = ['open', 'done'];

const ArgsSchema = z.object({
  slug: z.string().min(1).optional(),
  all_initiatives: z.boolean().optional(),
  tag: z.string().optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  status: StatusFilter.optional(),
  id: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
  due_before: z.string().min(1).optional(),
  sort: z.enum(['priority', 'due']).optional(),
  unblocked: z.boolean().optional(),
});

type Args = z.infer<typeof ArgsSchema>;

type TaskWithSlug = Task & { slug: string };

const ResultSchema = z.object({
  tasks: z.array(TaskSchema.extend({ slug: z.string() })),
});

type Result = z.infer<typeof ResultSchema>;

function isMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

interface CachedTask {
  mtimeMs: number;
  size: number;
  ino: number;
  task: Task;
}

// The daemon serves task.list for every console and factory read, and re-parsing ~9k YAML files per call cost
// seconds. Files stay authoritative and agents edit them directly with no event, so each call re-stats every file
// and re-parses only what changed. Keyed by tasks dir so a listing replaces its whole entry and vanished files drop.
const parsedByDir = new Map<string, Map<string, CachedTask>>();

const READ_CONCURRENCY = 16;

interface SlugListing {
  slug: string;
  dir: string;
  files: string[];
}

async function listTaskFiles(slug: string): Promise<SlugListing> {
  const dir = path.join(getInitiativeDir(slug), 'tasks');
  try {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.yml'));
    return { slug, dir, files };
  } catch (err) {
    if (!isMissing(err)) throw err;
    parsedByDir.delete(dir);
    return { slug, dir, files: [] };
  }
}

async function loadCachedTask(
  filePath: string,
  previous: CachedTask | undefined,
): Promise<CachedTask | undefined> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
  const { mtimeMs, size, ino } = stat;
  if (previous?.mtimeMs === mtimeMs && previous.size === size && previous.ino === ino) {
    return previous;
  }
  return { mtimeMs, size, ino, task: await readYaml(filePath, TaskSchema) };
}

async function loadListing(
  listing: SlugListing,
  keep: (t: Task) => boolean,
): Promise<TaskWithSlug[]> {
  const previous = parsedByDir.get(listing.dir);
  const current = new Map<string, CachedTask>();
  const entries = await mapConcurrent(listing.files, READ_CONCURRENCY, (file) =>
    loadCachedTask(path.join(listing.dir, file), previous?.get(file)),
  );
  const tasks: TaskWithSlug[] = [];
  entries.forEach((entry, i) => {
    if (!entry) return;
    current.set(listing.files[i], entry);
    if (keep(entry.task)) tasks.push({ ...entry.task, slug: listing.slug });
  });
  parsedByDir.set(listing.dir, current);
  return tasks;
}

function forgetMissingInitiatives(listings: SlugListing[]): void {
  const listed = new Set(listings.map((l) => l.dir));
  const root = getActiveRoot();
  for (const dir of parsedByDir.keys()) {
    if (path.dirname(path.dirname(dir)) === root && !listed.has(dir)) parsedByDir.delete(dir);
  }
}

function parseIds(raw: string | undefined): Set<string> | undefined {
  if (raw === undefined) return undefined;
  return new Set(
    raw
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

async function assertKnownStatus(activeRoot: string, status: string): Promise<void> {
  if (status === 'all' || status === 'closed' || BUILT_IN_STATUS_IDS.includes(status)) return;
  const registry = await loadCategoryRegistry(activeRoot);
  const allowed = registry ? registry.status.map((s) => s.id) : BUILT_IN_STATUS_IDS;
  if (allowed.includes(status)) return;
  throw new UsageError(
    `Unknown status: ${status} (allowed: ${[...allowed, 'closed', 'all'].join(', ')})`,
  );
}

function statusMatcher(status: string, closed: ReadonlySet<string>): (t: Task) => boolean {
  if (status === 'all') return () => true;
  if (status === 'closed') return (t) => closed.has(t.status);
  return (t) => t.status === status;
}

function parseDueBefore(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!TaskSchema.shape.due.safeParse(raw).success) {
    throw new UsageError(`Invalid --due-before date: ${raw} (expected YYYY-MM-DD)`);
  }
  return raw;
}

// Undated tasks sort after every dated one; priority breaks ties.
function compareByDue(a: Task, b: Task): number {
  if (a.due !== b.due) {
    if (!a.due) return 1;
    if (!b.due) return -1;
    return a.due < b.due ? -1 : 1;
  }
  return a.priority - b.priority;
}

// Deps may live in initiatives outside the listed slugs, so they resolve against the whole root.
async function withoutOpenDeps(tasks: TaskWithSlug[]): Promise<TaskWithSlug[]> {
  const activeRoot = getActiveRoot();
  const lookup = {
    closed: await closedStatusIds(activeRoot),
    find: createDepFinder(activeRoot),
  };
  const kept: TaskWithSlug[] = [];
  for (const task of tasks) {
    if ((await openDeps(task, lookup)).length === 0) kept.push(task);
  }
  return kept;
}

async function buildFilter(args: Args): Promise<(t: Task) => boolean> {
  const ids = parseIds(args.id);
  // Asking for ids by name should not hide them because they are already done.
  const status = args.status ?? (ids ? 'all' : 'open');
  const activeRoot = getActiveRoot();
  await assertKnownStatus(activeRoot, status);
  const closed = status === 'closed' ? await closedStatusIds(activeRoot) : new Set<string>();
  const matchesStatus = statusMatcher(status, closed);
  const needle = args.search?.toLowerCase();
  const dueBefore = parseDueBefore(args.due_before);
  return (t) => {
    if (dueBefore && (!t.due || t.due > dueBefore)) return false;
    if (!matchesStatus(t)) return false;
    if (args.tag && !(t.tags ?? []).includes(args.tag)) return false;
    if (args.severity && t.severity !== args.severity) return false;
    if (ids && !ids.has(t.id)) return false;
    if (needle && !`${t.id}\n${t.title}`.toLowerCase().includes(needle)) return false;
    return true;
  };
}

export default defineCommand<Args, Result>({
  name: 'task.list',
  description: 'List tasks for an initiative or across all initiatives',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      all_initiatives: {
        long: '--all-initiatives',
        description: 'Scan every initiative under the active root',
      },
      tag: { long: '--tag', description: 'Filter by tag membership' },
      severity: {
        long: '--severity',
        description: 'Filter by severity (critical|high|medium|low)',
      },
      status: {
        long: '--status',
        description:
          'open (default; all with --id), any status in the category registry, closed (every closed status), or all',
      },
      id: {
        long: '--id',
        description: 'Keep only these comma-separated ids, e.g. TP-1,TP-2',
      },
      search: {
        long: '--search',
        description: 'Case-insensitive substring match on title or id',
      },
      due_before: {
        long: '--due-before',
        description: 'Keep only tasks due on or before this date (YYYY-MM-DD); drops undated tasks',
      },
      unblocked: {
        long: '--unblocked',
        description: 'Keep only tasks whose every dep is closed, archived or done',
      },
      sort: {
        long: '--sort',
        description:
          'priority (default) or due (earliest first, undated last, priority breaks ties)',
      },
    },
  },
  async run(args, ctx) {
    const keep = await buildFilter(args);
    const slugs: string[] = args.all_initiatives
      ? await listSlugsForCaller(getActiveRoot(), ctx)
      : (() => {
          if (!args.slug) {
            throw new UsageError('task.list requires --all-initiatives or a slug');
          }
          return [args.slug];
        })();

    const listings = await mapConcurrent(slugs, READ_CONCURRENCY, listTaskFiles);
    // A non-owner's listing omits hidden initiatives that still exist, so only a full listing may evict.
    if (args.all_initiatives && ctx.caller === 'owner') forgetMissingInitiatives(listings);

    const tasks: TaskWithSlug[] = [];
    for (const listing of listings) {
      for (const task of await loadListing(listing, keep)) tasks.push(task);
    }
    const listed = args.unblocked ? await withoutOpenDeps(tasks) : tasks;
    listed.sort(args.sort === 'due' ? compareByDue : (a, b) => a.priority - b.priority);
    return { tasks: listed };
  },
});
