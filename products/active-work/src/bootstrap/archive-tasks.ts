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
import type { LoadedTasks, MalformedTask } from './prompt.js';

const MS_PER_DAY = 86_400_000;

export interface ArchiveStaleTasksOptions {
  /** Done tasks whose `done_at` is older than this many days are archived. */
  retentionDays: number;
  /** Reference time (injectable for tests). */
  now: Date;
}

export interface ArchiveStaleTasksResult extends LoadedTasks {
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
  const cutoffMs = opts.now.getTime() - opts.retentionDays * MS_PER_DAY;
  const archiveEnabled = opts.retentionDays > 0;
  const archived: string[] = [];
  const tasks: Task[] = [];
  const malformed: MalformedTask[] = [];

  for (const filename of ymlFiles) {
    const fullPath = path.join(tasksDir, filename);
    let task: Task;
    try {
      task = await readYaml(fullPath, TaskSchema);
    } catch (err) {
      malformed.push({ file: filename, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (archiveEnabled && (await archiveIfStale(task, fullPath, tasksDir, filename, cutoffMs))) {
      archived.push(task.id);
    } else {
      tasks.push(task);
    }
  }
  return { archivedIds: archived.sort(), tasks, malformed };
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
