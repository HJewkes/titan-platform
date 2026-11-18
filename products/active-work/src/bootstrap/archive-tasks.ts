/**
 * Auto-archive stale done tasks during bootstrap (AW-8).
 *
 * A `done` task whose `done_at` is older than `retentionDays` is moved from
 * `tasks/<id>.yml` into `tasks/archive/<id>.yml`. Every task reader filters by
 * the `.yml`/`.yaml` extension, so the `archive/` subdirectory is naturally
 * excluded from the active list while the file is preserved for recovery.
 *
 * Best-effort: unreadable/malformed task files and per-file move failures are
 * skipped rather than aborting the bootstrap.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { readYaml } from '../utils/yaml-io.js';
import { TaskSchema, type Task } from '../schemas/task.js';
import { mapConcurrent } from '../utils/map-concurrent.js';
import type { LoadedTasks, MalformedTask } from './prompt.js';
import {
  defaultTaskParseCachePath,
  loadTaskParseCache,
  saveTaskParseCache,
  statStamp,
  type TaskParseCache,
} from './task-parse-cache.js';

const MS_PER_DAY = 86_400_000;
/** One read awaited at a time left the parser idle on every file's I/O round trip (TP-4660). */
const TASK_READ_CONCURRENCY = 32;

type TaskReader = (fullPath: string) => Promise<Task>;

const readTaskFile: TaskReader = (fullPath) => readYaml(fullPath, TaskSchema);

interface ArchiveStaleTasksOptions {
  /** Done tasks whose `done_at` is older than this many days are archived. */
  retentionDays: number;
  /** Reference time (injectable for tests). */
  now: Date;
  /** Parses one task file; defaults to the schema-validating YAML reader. */
  readTask?: TaskReader;
  /** Parsed-task sidecar; defaults under the state root, `null` parses every file. */
  parseCachePath?: string | null;
}

interface ArchiveStaleTasksResult extends LoadedTasks {
  /** Ids moved to `tasks/archive/` (sorted). */
  archivedIds: string[];
}

/**
 * Move stale done tasks into `tasks/archive/`. A non-positive `retentionDays`
 * disables archiving. Every task file is parsed exactly once; the returned
 * `tasks` and `malformed` are what remains in `tasks/` afterwards, so the
 * bootstrap does not have to read the directory again.
 */
export async function archiveStaleTasks(
  initiativeDir: string,
  opts: ArchiveStaleTasksOptions,
): Promise<ArchiveStaleTasksResult> {
  const tasksDir = path.join(initiativeDir, 'tasks');
  let entries: string[];
  try {
    entries = await fsp.readdir(tasksDir);
  } catch {
    return { archivedIds: [], tasks: [], malformed: [] };
  }
  const ymlFiles = entries.filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'));
  const readTask = opts.readTask ?? readTaskFile;
  const cachePath =
    opts.parseCachePath === undefined ? defaultTaskParseCachePath(tasksDir) : opts.parseCachePath;
  const cached: TaskParseCache = cachePath ? await loadTaskParseCache(cachePath) : new Map();
  const fresh: TaskParseCache = new Map();
  const parsed = await mapConcurrent(ymlFiles, TASK_READ_CONCURRENCY, (filename) =>
    parseOrReuse(tasksDir, filename, { readTask, cached, fresh }),
  );
  const result = await sortParsed(parsed, tasksDir, opts, (filename) => fresh.delete(filename));
  if (cachePath && cacheChanged(cached, fresh)) await saveTaskParseCache(cachePath, fresh);
  return result;
}

interface ParseContext {
  readTask: TaskReader;
  cached: TaskParseCache;
  /** Entries for this run's files, which become the next sidecar. */
  fresh: TaskParseCache;
}

/** The stamp is read before the file, so an edit racing this open leaves a stale stamp. */
async function parseOrReuse(
  tasksDir: string,
  filename: string,
  ctx: ParseContext,
): Promise<ParsedTaskFile> {
  const stamp = await statStamp(path.join(tasksDir, filename));
  const hit = ctx.cached.get(filename);
  if (stamp !== null && hit?.stamp === stamp) {
    ctx.fresh.set(filename, hit);
    return { task: hit.task, filename };
  }
  const entry = await parseTaskFile(tasksDir, filename, ctx.readTask);
  if (stamp !== null && 'task' in entry) ctx.fresh.set(filename, { stamp, task: entry.task });
  return entry;
}

function cacheChanged(cached: TaskParseCache, fresh: TaskParseCache): boolean {
  if (cached.size !== fresh.size) return true;
  for (const [filename, entry] of fresh) {
    if (cached.get(filename) !== entry) return true;
  }
  return false;
}

type ParsedTaskFile = { task: Task; filename: string } | MalformedTask;

async function sortParsed(
  parsed: ParsedTaskFile[],
  tasksDir: string,
  opts: ArchiveStaleTasksOptions,
  onArchived: (filename: string) => void,
): Promise<ArchiveStaleTasksResult> {
  const cutoffMs = opts.now.getTime() - opts.retentionDays * MS_PER_DAY;
  const archiveEnabled = opts.retentionDays > 0;
  const archived: string[] = [];
  const tasks: Task[] = [];
  const malformed: MalformedTask[] = [];
  for (const entry of parsed) {
    if ('reason' in entry) {
      malformed.push(entry);
      continue;
    }
    const { task, filename } = entry;
    const fullPath = path.join(tasksDir, filename);
    if (archiveEnabled && (await archiveIfStale(task, fullPath, tasksDir, filename, cutoffMs))) {
      archived.push(task.id);
      onArchived(filename);
    } else {
      tasks.push(task);
    }
  }
  return { archivedIds: archived.sort(), tasks, malformed };
}

async function parseTaskFile(
  tasksDir: string,
  filename: string,
  readTask: TaskReader,
): Promise<ParsedTaskFile> {
  try {
    return { task: await readTask(path.join(tasksDir, filename)), filename };
  } catch (err) {
    return { file: filename, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function archiveIfStale(
  task: Task,
  fullPath: string,
  tasksDir: string,
  filename: string,
  cutoffMs: number,
): Promise<boolean> {
  if (task.status !== 'done' || !task.done_at) return false;
  const doneMs = new Date(task.done_at).getTime();
  if (Number.isNaN(doneMs) || doneMs > cutoffMs) return false;
  try {
    const archiveDir = path.join(tasksDir, 'archive');
    await fsp.mkdir(archiveDir, { recursive: true });
    await fsp.rename(fullPath, path.join(archiveDir, filename));
    return true;
  } catch {
    return false; // best-effort: skip files we can't move
  }
}
