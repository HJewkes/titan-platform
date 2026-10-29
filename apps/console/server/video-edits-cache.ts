import { promises as fsp } from "node:fs";
import path from "node:path";

/** The filesystem reads a stamp needs, injectable so tests need no real store. */
export interface StampFs {
  readdir(dir: string): Promise<string[]>;
  stat(file: string): Promise<{ mtimeMs: number; size: number } | null>;
  readlink(link: string): Promise<string | null>;
}

const orNull = <T>(read: Promise<T>): Promise<T | null> => read.catch(() => null);

const realStampFs: StampFs = {
  readdir: async (dir) => (await orNull(fsp.readdir(dir))) ?? [],
  stat: async (file) => {
    const stats = await orNull(fsp.stat(file));
    return stats === null ? null : { mtimeMs: stats.mtimeMs, size: stats.size };
  },
  readlink: (link) => orNull(fsp.readlink(link)),
};

const MAX_CACHED = 64;

/**
 * Everything that can change `explainer edit list`: each ledger file, the run state it reads a status from (the WAL
 * included, since a commit lands there first), and the release `cli/current` points at. A directory mtime alone misses
 * a ledger rewritten in place, so each file's own mtime and size go in.
 */
export async function editsStamp(dataDir: string, fs: StampFs = realStampFs): Promise<string> {
  const editsDir = path.join(dataDir, "edits");
  const ledgers = (await fs.readdir(editsDir)).filter((name) => name.endsWith(".json")).sort().map((name) => path.join(editsDir, name));
  const state = ["state.sqlite3", "state.sqlite3-wal"].map((name) => path.join(dataDir, name));
  const marks = await Promise.all([...ledgers, ...state].map(async (file) => `${file}:${JSON.stringify(await fs.stat(file))}`));
  return [...marks, `cli:${await fs.readlink(path.join(dataDir, "cli", "current"))}`].join("\n");
}

/** Keeps one answer per video while its stamp holds. `keep` says which answers are worth keeping; a gap is asked again. */
export function stampedMemo<T>(stamp: () => Promise<string>, read: (key: string) => Promise<T>, keep: (value: T) => boolean): (key: string) => Promise<T> {
  const kept = new Map<string, { stamp: string; value: T }>();
  return async (key) => {
    const now = await stamp();
    const hit = kept.get(key);
    if (hit !== undefined && hit.stamp === now) return hit.value;
    const value = await read(key);
    if (!keep(value)) return value;
    if (kept.size >= MAX_CACHED && !kept.has(key)) kept.delete(kept.keys().next().value!);
    kept.set(key, { stamp: now, value });
    return value;
  };
}
