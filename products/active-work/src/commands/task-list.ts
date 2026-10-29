import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { TaskSchema, type Task } from '../schemas/task.js';
import { getActiveRoot, getInitiativeDir } from '../utils/paths.js';
import { mapConcurrent } from '../utils/map-concurrent.js';
import { readYaml } from '../utils/yaml-io.js';
import { UsageError } from '../errors.js';

// No schema default: buildFilter picks it, because the default depends on --id.
const StatusFilter = z.enum(['open', 'done', 'all']);

const ArgsSchema = z.object({
  slug: z.string().min(1).optional(),
  all_initiatives: z.boolean().optional(),
  tag: z.string().optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  status: StatusFilter.optional(),
  id: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
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

async function listSlugs(): Promise<string[]> {
  const root = getActiveRoot();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
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

function buildFilter(args: Args): (t: Task) => boolean {
  const ids = parseIds(args.id);
  // Asking for ids by name should not hide them because they are already done.
  const status = args.status ?? (ids ? 'all' : 'open');
  const needle = args.search?.toLowerCase();
  return (t) => {
    if (status !== 'all' && t.status !== status) return false;
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
        description: 'open (default; all with --id), done, or all',
      },
      id: { long: '--id', description: 'Keep only these comma-separated ids, e.g. TP-1,TP-2' },
      search: {
        long: '--search',
        description: 'Case-insensitive substring match on title or id',
      },
    },
  },
  async run(args) {
    const keep = buildFilter(args);
    const slugs: string[] = args.all_initiatives
      ? await listSlugs()
      : (() => {
          if (!args.slug) {
            throw new UsageError('task.list requires --all-initiatives or a slug');
          }
          return [args.slug];
        })();

    const listings = await mapConcurrent(slugs, READ_CONCURRENCY, listTaskFiles);
    if (args.all_initiatives) forgetMissingInitiatives(listings);

    const tasks: TaskWithSlug[] = [];
    for (const listing of listings) {
      for (const task of await loadListing(listing, keep)) tasks.push(task);
    }
    tasks.sort((a, b) => a.priority - b.priority);
    return { tasks };
  },
});
