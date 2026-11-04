import { promises as fs } from 'node:fs';
import path from 'node:path';
import { scanInventory, scanInventorySlug, type InventoryFile } from './inventory.js';

/**
 * Per-initiative memo of `scanInventorySlug` (TP-4508).
 *
 * A full scan stats every file under the active root, which takes seconds on a
 * large one, and the console calls `inventory` on its hot reads. Adding or
 * removing a file bumps its directory's mtime, so a scan is reused while the
 * mtimes of the directories below are unchanged, which keeps those counts exact.
 * An in-place edit bumps no directory mtime, and neither does a file added
 * deeper than these directories (a nested source under `sources/<dir>/`), so
 * `bytes`, `newest_mtime` and nested counts may lag by up to `ttlMs`.
 *
 * The daemon is the one long-lived process, so the cache lives there; a CLI
 * call is a fresh process and always scans.
 */

const STAMP_DIRS = ['.', 'tasks', 'tasks/archive', 'sessions', 'sources', 'sources/notes', 'artifacts'];

const INVENTORY_TTL_MS = 30_000;

type ScanSlug = (activeRoot: string, slug: string) => Promise<InventoryFile[]>;

interface InventoryCacheDeps {
  scanSlug?: ScanSlug;
  now?: () => number;
  ttlMs?: number;
}

interface Entry {
  stamp: string;
  scannedAt: number;
  files: Promise<InventoryFile[]>;
}

async function dirMtime(dir: string): Promise<number> {
  try {
    return (await fs.stat(dir)).mtimeMs;
  } catch {
    return -1;
  }
}

async function dirStamp(activeRoot: string, slug: string): Promise<string> {
  const mtimes = await Promise.all(
    STAMP_DIRS.map((rel) => dirMtime(path.join(activeRoot, slug, rel))),
  );
  return mtimes.join(',');
}

export function createInventoryCache(deps: InventoryCacheDeps = {}) {
  const { scanSlug = scanInventorySlug, now = Date.now, ttlMs = INVENTORY_TTL_MS } = deps;
  const entries = new Map<string, Entry>();

  async function cachedSlug(activeRoot: string, slug: string): Promise<InventoryFile[]> {
    const key = `${activeRoot}\0${slug}`;
    const stamp = await dirStamp(activeRoot, slug);
    const hit = entries.get(key);
    if (hit && hit.stamp === stamp && now() - hit.scannedAt < ttlMs) return hit.files;
    const files = scanSlug(activeRoot, slug);
    const entry = { stamp, scannedAt: now(), files };
    entries.set(key, entry);
    files.catch(() => {
      if (entries.get(key) === entry) entries.delete(key);
    });
    return files;
  }

  return {
    scan: (activeRoot: string) => scanInventory(activeRoot, cachedSlug),
  };
}

/** The process's one cache, shared by every `inventory` call the daemon serves. */
export const inventoryCache = createInventoryCache();
