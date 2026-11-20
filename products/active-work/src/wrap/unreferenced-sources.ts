import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listSources } from '../sources/list.js';
import { scanNestedSources } from '../workspace-index/inventory.js';

interface UnreferencedSource {
  filename: string;
  /** Absolute path. */
  path: string;
  mtime: string;
}

/** Text of every file in `dir` with the given extension; a missing dir reads as empty. */
async function readTexts(dir: string, extension: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const texts = await Promise.all(
    names
      .filter((name) => name.endsWith(extension))
      .map((name) => fs.readFile(path.join(dir, name), 'utf8').catch(() => '')),
  );
  return texts;
}

async function readReferenceCorpus(initiativeDir: string): Promise<string> {
  const [tasks, sessions, notes] = await Promise.all([
    readTexts(path.join(initiativeDir, 'tasks'), '.yml'),
    readTexts(path.join(initiativeDir, 'sessions'), '.md'),
    readTexts(path.join(initiativeDir, 'sources', 'notes'), '.md'),
  ]);
  return [...tasks, ...sessions, ...notes].join('\n');
}

interface Candidate {
  /** Path relative to `sources/`, `/`-separated. */
  relative: string;
  absolute: string;
  mtime: string;
}

async function topLevelCandidates(initiativeDir: string): Promise<Candidate[]> {
  const entries = await listSources(initiativeDir);
  const stats = await Promise.all(
    entries.map(async (entry) => ({ entry, stat: await fs.stat(entry.path).catch(() => null) })),
  );
  return stats.flatMap(({ entry, stat }) =>
    stat
      ? [{ relative: entry.filename, absolute: entry.path, mtime: stat.mtime.toISOString() }]
      : [],
  );
}

async function nestedCandidates(
  activeRoot: string,
  slug: string,
  initiativeDir: string,
): Promise<Candidate[]> {
  const sourcesDir = path.join(initiativeDir, 'sources');
  const files = await scanNestedSources(activeRoot, slug);
  return files.map((file) => ({
    relative: path.relative(sourcesDir, file.absolutePath).split(path.sep).join('/'),
    absolute: file.absolutePath,
    mtime: file.mtime,
  }));
}

/**
 * Sources written at or after `since` that no task, session ledger or note
 * names, by filename or by sources-relative path. Sorted by relative path.
 */
export async function findUnreferencedSources(
  activeRoot: string,
  slug: string,
  since: string,
): Promise<UnreferencedSource[]> {
  const initiativeDir = path.join(activeRoot, slug);
  const sinceMs = Date.parse(since);
  const [top, nested, corpus] = await Promise.all([
    topLevelCandidates(initiativeDir),
    nestedCandidates(activeRoot, slug, initiativeDir),
    readReferenceCorpus(initiativeDir),
  ]);
  return [...top, ...nested]
    .filter((c) => Date.parse(c.mtime) >= sinceMs)
    .filter((c) => !corpus.includes(c.relative) && !corpus.includes(path.posix.basename(c.relative)))
    .sort((a, b) => a.relative.localeCompare(b.relative))
    .map((c) => ({ filename: path.posix.basename(c.relative), path: c.absolute, mtime: c.mtime }));
}
