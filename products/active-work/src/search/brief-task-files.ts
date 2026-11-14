import path from 'node:path';
import { TaskSchema, type Task } from '../schemas/task.js';
import { listShownSlugs, visibilityFor, type Shown } from '../sessions/visibility.js';
import { readYaml } from '../utils/yaml-io.js';

/**
 * The files a spawn brief is about (TP-5453 P11b): paths the assignment names outright, plus the
 * paths in the done_when and owns clause of each task it names. A task key is resolved by file
 * name, never by similarity, and only in an initiative the agent view shows.
 */

const NAMED_FILES_MAX = 20;
const TASK_KEYS_MAX = 5;

/** Repo-relative paths only: a path after a `/`, `~` or `://` is absolute or a URL and is skipped. */
const NAMED_FILE = /(?<![\w./~-])(?:[\w.-]+\/)+[\w-][\w.-]*\.[A-Za-z0-9]+(?![\w/])/g;
const TASK_KEY = /\b[A-Z][A-Z0-9]*-\d+\b/g;
/** Notes carry the slice's owned files as prose, `owns: a.ts, b.ts`, running to the next blank line. */
const OWNS_CLAUSE = /\b(?:owns|owned files|owned globs)\s*:([\s\S]*?)(?:\n\s*\n|$)/gi;

/** Distinct repo-relative paths in `text`, in the order they first appear. */
export function namedFiles(text: string): string[] {
  const paths = new Set(Array.from(text.matchAll(NAMED_FILE), (match) => match[0]));
  return [...paths].slice(0, NAMED_FILES_MAX);
}

function taskKeys(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(TASK_KEY), (match) => match[0]))].slice(0, TASK_KEYS_MAX);
}

function ownsClauses(notes: string | undefined): string {
  if (notes === undefined) return '';
  return Array.from(notes.matchAll(OWNS_CLAUSE), (match) => match[1]).join('\n');
}

async function readTask(activeRoot: string, slug: string, key: string): Promise<Task | null> {
  try {
    return await readYaml(path.join(activeRoot, slug, 'tasks', `${key}.yml`), TaskSchema);
  } catch {
    return null;
  }
}

/** The named initiative first, so a key two initiatives share resolves to the caller's. */
async function shownSlugs(activeRoot: string, shown: Shown, initiative?: string): Promise<string[]> {
  const slugs = await listShownSlugs(activeRoot, shown).catch((): string[] => []);
  if (initiative === undefined || !slugs.includes(initiative)) return slugs;
  return [initiative, ...slugs.filter((slug) => slug !== initiative)];
}

async function resolveTask(activeRoot: string, slugs: readonly string[], key: string): Promise<Task | null> {
  for (const slug of slugs) {
    const task = await readTask(activeRoot, slug, key);
    if (task !== null) return task;
  }
  return null;
}

interface TaskFilesInput {
  text: string;
  activeRoot: string;
  initiative?: string;
}

/** Always the agent view: `/rpc` runs every caller as the owner, so no caller is consulted. */
export async function taskFiles(input: TaskFilesInput): Promise<string[]> {
  const keys = taskKeys(input.text);
  if (keys.length === 0) return namedFiles(input.text);
  const shown = await visibilityFor({ activeRoot: input.activeRoot, warnings: [] });
  const slugs = await shownSlugs(input.activeRoot, shown, input.initiative);
  const tasks = await Promise.all(keys.map((key) => resolveTask(input.activeRoot, slugs, key)));
  const fromTasks = tasks.flatMap((task) => (task === null ? [] : [task.done_when ?? '', ownsClauses(task.notes)]));
  return namedFiles([input.text, ...fromTasks].join('\n'));
}
