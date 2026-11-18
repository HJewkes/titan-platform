import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TaskSchema, type Task } from '../schemas/task.js';
import { getActiveRoot, getInitiativeDir } from '../utils/paths.js';
import { readYaml } from '../utils/yaml-io.js';

export interface LocatedTask {
  task: Task;
  archived: boolean;
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

async function readIfPresent(file: string): Promise<Task | undefined> {
  try {
    return await readYaml(file, TaskSchema);
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
}

/** The live task file, else its archived copy, else undefined. The id must already be a valid task id. */
export async function locateTask(slug: string, id: string): Promise<LocatedTask | undefined> {
  const tasksDir = path.join(getInitiativeDir(slug), 'tasks');
  const live = await readIfPresent(path.join(tasksDir, `${id}.yml`));
  if (live) return { task: live, archived: false };
  const archived = await readIfPresent(path.join(tasksDir, 'archive', `${id}.yml`));
  return archived ? { task: archived, archived: true } : undefined;
}

async function hasFile(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

/** Every initiative holding the id live or archived, found by file name alone. */
export async function homesOf(id: string): Promise<string[]> {
  const entries = await fs.readdir(getActiveRoot(), { withFileTypes: true });
  const slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const holds = await Promise.all(
    slugs.map(async (slug) => {
      const tasksDir = path.join(getInitiativeDir(slug), 'tasks');
      return (
        (await hasFile(path.join(tasksDir, `${id}.yml`))) ||
        (await hasFile(path.join(tasksDir, 'archive', `${id}.yml`)))
      );
    }),
  );
  return slugs.filter((_, i) => holds[i]);
}
