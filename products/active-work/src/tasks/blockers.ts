import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readEdges } from '@titan-design/pm';
import { TaskSchema, type Task } from '../schemas/task.js';
import { readYaml } from '../utils/yaml-io.js';

interface DepRecord {
  status: string;
  archived: boolean;
}

export interface DepLookup {
  closed: ReadonlySet<string>;
  find(id: string): Promise<DepRecord | undefined>;
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

async function initiativeDirs(activeRoot: string): Promise<string[]> {
  const entries = await fs.readdir(activeRoot, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(activeRoot, e.name));
}

async function locate(dirs: string[], id: string): Promise<DepRecord | undefined> {
  for (const dir of dirs) {
    const file = path.join(dir, 'tasks', `${id}.yml`);
    if (await exists(file)) {
      return { status: (await readYaml(file, TaskSchema)).status, archived: false };
    }
    // An archived task is closed by definition, so its file need not be parsed.
    if (await exists(path.join(dir, 'tasks', 'archive', `${id}.yml`))) {
      return { status: 'archived', archived: true };
    }
  }
  return undefined;
}

/** Resolves a task id to its file by name across every initiative, reading each id's file at most once. */
export function createDepFinder(activeRoot: string): DepLookup['find'] {
  const cache = new Map<string, Promise<DepRecord | undefined>>();
  let dirs: Promise<string[]> | undefined;
  return (id) => {
    let found = cache.get(id);
    if (!found) {
      dirs ??= initiativeDirs(activeRoot);
      found = dirs.then((list) => locate(list, id));
      cache.set(id, found);
    }
    return found;
  };
}

/** The deps of a task that are not yet closed; an id that resolves to no file counts as open. */
export async function openDeps(task: Task, lookup: DepLookup): Promise<string[]> {
  const open: string[] = [];
  for (const id of readEdges(task).dep) {
    const record = await lookup.find(id);
    if (!record || (!record.archived && !lookup.closed.has(record.status))) open.push(id);
  }
  return open;
}
