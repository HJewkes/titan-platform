/**
 * Sidecar of parsed task files for the open archive pass (TP-6711).
 *
 * Parsing every task YAML and validating it was most of the archive phase on a
 * large initiative, and nearly all files are unchanged between two opens. Each
 * entry is keyed by filename and stamped with the file's inode, size, mtime
 * and ctime, read before the file itself, so an edit made after the stat
 * leaves a stale stamp and the next open parses the file again. An atomic
 * rename changes the inode and an in-place write changes mtime and ctime.
 *
 * The sidecar is a cache, not a record: anything wrong with it (missing,
 * unparseable, another build's format, a malformed entry) reads as a miss and
 * the file is parsed in full. Writes skip fsync and swallow errors, since a
 * torn or absent sidecar only costs the next open a full parse.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Task } from '../schemas/task.js';
import { getStateRoot } from '../utils/paths.js';
import { BUILD_VERSION } from '../version.js';

/** Bump when the sidecar layout changes; the build version covers schema changes. */
const CACHE_FORMAT = 1;
const CACHE_KEY = `${CACHE_FORMAT}:${BUILD_VERSION}`;

interface CacheEntry {
  stamp: string;
  task: Task;
}

export type TaskParseCache = Map<string, CacheEntry>;

/**
 * One file per tasks directory. Under the state root rather than the cache root because
 * test runs isolate the state root but share the operator's cache root.
 */
export function defaultTaskParseCachePath(tasksDir: string): string {
  const digest = createHash('sha256').update(path.resolve(tasksDir)).digest('hex').slice(0, 16);
  return path.join(getStateRoot(), 'task-parse', `${digest}.json`);
}

/** The file's identity stamp, or `null` when it cannot be stat'd (never cached). */
export async function statStamp(fullPath: string): Promise<string | null> {
  try {
    const st = await fsp.stat(fullPath);
    return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  } catch {
    return null;
  }
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (value === null || typeof value !== 'object') return false;
  const { stamp, task } = value as { stamp?: unknown; task?: unknown };
  if (typeof stamp !== 'string' || task === null || typeof task !== 'object') return false;
  const { id, status } = task as { id?: unknown; status?: unknown };
  return typeof id === 'string' && typeof status === 'string';
}

/** Read the sidecar; any failure yields an empty cache. */
export async function loadTaskParseCache(cachePath: string): Promise<TaskParseCache> {
  const cache: TaskParseCache = new Map();
  try {
    const doc = JSON.parse(await fsp.readFile(cachePath, 'utf8')) as {
      key?: unknown;
      entries?: unknown;
    };
    if (doc.key !== CACHE_KEY || doc.entries === null || typeof doc.entries !== 'object') {
      return cache;
    }
    for (const [filename, entry] of Object.entries(doc.entries as Record<string, unknown>)) {
      if (isCacheEntry(entry)) cache.set(filename, entry);
    }
  } catch {
    return new Map();
  }
  return cache;
}

/** Replace the sidecar with `cache`; failures are swallowed. */
export async function saveTaskParseCache(cachePath: string, cache: TaskParseCache): Promise<void> {
  const tempPath = `${cachePath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    const doc = { key: CACHE_KEY, entries: Object.fromEntries(cache) };
    await fsp.writeFile(tempPath, JSON.stringify(doc), 'utf8');
    await fsp.rename(tempPath, cachePath);
  } catch {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
