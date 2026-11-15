import path from 'node:path';
import { checkEdges, type EdgeError, type Task } from '@titan-design/pm';
import { readInitiativeTasks } from '@titan-design/pm/node';
import type { LintFinding } from './types.js';

/** Every live task under the active root, plus ids that resolve only because they are archived. */
export interface TaskIndex {
  tasks: { slug: string; task: Task }[];
  archivedIds: ReadonlySet<string>;
}

/** Built once per lintAll run so each slug does not re-read every other initiative. */
export async function loadTaskIndex(activeRoot: string, slugs: string[]): Promise<TaskIndex> {
  const tasks: TaskIndex['tasks'] = [];
  const archivedIds = new Set<string>();
  for (const slug of slugs) {
    const all = await readInitiativeTasks(activeRoot, slug, { archive: true });
    const live = await readInitiativeTasks(activeRoot, slug);
    const liveIds = new Set(live.tasks.map((row) => row.task.id));
    for (const row of live.tasks) tasks.push({ slug, task: row.task });
    for (const row of all.tasks) if (!liveIds.has(row.task.id)) archivedIds.add(row.task.id);
  }
  return { tasks, archivedIds };
}

const file = (id: string): string => path.posix.join('tasks', `${id}.yml`);

/** Rotate so the smallest id leads; the same cycle then has one owner whichever task found it. */
function canonicalCycle(ids: string[]): string[] {
  const start = ids.indexOf([...ids].sort()[0]);
  return [...ids.slice(start), ...ids.slice(0, start)];
}

function describe(id: string, error: EdgeError): string | null {
  if (error.kind === 'unknown-id') {
    return `task ${id} ${error.field} ${error.ref} is not a known task id`;
  }
  const ids = canonicalCycle(error.ids);
  if (ids[0] !== id) return null;
  return `task ${id} is in a ${error.field} cycle: ${[...ids, ids[0]].join(' -> ')}`;
}

/**
 * Warn about unknown parent or dep ids and about parent or dep cycles. Edges come through pm
 * `readEdges`, so tag-only edges count. A cycle is reported only by the slug that holds its
 * smallest id, so a cycle across initiatives appears once.
 */
export function lintEdges(slug: string, index: TaskIndex): LintFinding[] {
  const graph = index.tasks.map((entry) => entry.task);
  const findings: LintFinding[] = [];
  for (const { slug: home, task } of index.tasks) {
    if (home !== slug) continue;
    for (const error of checkEdges(graph, { id: task.id }).errors) {
      if (error.kind === 'unknown-id' && index.archivedIds.has(error.ref)) continue;
      const message = describe(task.id, error);
      if (message !== null) {
        findings.push({ level: 'warn', slug, file: file(task.id), message });
      }
    }
  }
  return findings;
}
