import fs from 'node:fs';
import type { WorkspaceGraph } from '../session-index/graph.js';

/**
 * Document-frequency counts kept beside the graph file, so a CLI `open` reads
 * the counts an earlier process paid for instead of asking FTS5's vocabulary
 * again (40-140 ms a common term on a large index, TP-6710).
 *
 * A sidecar, not a table: `open` would otherwise write to the graph while the
 * daemon may hold its write lock. Counts are stamped with the graph's inode and
 * highest span ids. A pass that indexed spans deletes the file outright; the
 * stamp catches a write from a process that never got to delete it, and a
 * rebuilt graph swapped in under the same path.
 */
const STORE_VERSION = 1;

interface StoredCounts {
  v: number;
  stamp: string;
  terms: Record<string, number>;
}

function storePath(dbName: string): string | null {
  return dbName === '' || dbName === ':memory:' ? null : `${dbName}-df.json`;
}

/** What the counts were read against; any span write or file swap changes it. */
export function indexStamp(graph: WorkspaceGraph, spanIds: { search: number; workspace: number }): string {
  return `${fs.statSync(graph.db.name).ino}:${spanIds.search}:${spanIds.workspace}`;
}

/** Counts persisted for this stamp, or none when the file is absent, stale or unreadable. */
export function readStoredCounts(dbName: string, stamp: string): Map<string, number> {
  const file = storePath(dbName);
  if (!file) return new Map();
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoredCounts>;
    if (stored.v !== STORE_VERSION || stored.stamp !== stamp || !isTermRecord(stored.terms)) {
      return new Map();
    }
    return new Map(Object.entries(stored.terms));
  } catch {
    return new Map();
  }
}

function isTermRecord(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0);
}

/** Best effort: a count that fails to persist is paid for again by the next process. */
export function writeStoredCounts(dbName: string, stamp: string, terms: Map<string, number>): void {
  const file = storePath(dbName);
  if (!file) return;
  const body: StoredCounts = { v: STORE_VERSION, stamp, terms: Object.fromEntries(terms) };
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(body));
    fs.renameSync(temp, file);
  } catch {
    fs.rmSync(temp, { force: true });
  }
}

export function removeStoredCounts(dbName: string): void {
  const file = storePath(dbName);
  if (file) fs.rmSync(file, { force: true });
}
