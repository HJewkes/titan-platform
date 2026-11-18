import { existsSync } from 'node:fs';
import path from 'node:path';
import { agentChatHome, openBriefly, type OpenDatabase } from './origin-agent-chat-read.js';
import type { Task } from '../schemas/task.js';

/*
 * A task counts as dispatched once it has started or once any agent-chat spawn names it in `meta.task`, bare (`TP-7`)
 * or initiative-qualified (`demo/TP-7`). `events.db` is read read-only, under the same temporary coupling as the
 * session-origin resolver (TP-274). A store that exists but cannot be read counts as dispatched, so a locked or
 * damaged store refuses the relabel instead of letting it through.
 */

const SPAWN_NAMES_TASK = `SELECT 1 FROM events
  WHERE kind IN ('agent_spawned', 'agent_resumed') AND json_extract(meta, '$.task') IN (?, ?)
  LIMIT 1`;

function spawnNamesTask(file: string, open: OpenDatabase, slug: string, id: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const db = open(file, { readonly: true, fileMustExist: true });
    try {
      return db.prepare(SPAWN_NAMES_TASK).get(id, `${slug}/${id}`) !== undefined;
    } finally {
      db.close();
    }
  } catch {
    return true;
  }
}

// Task files from before started_at carry only the status.
const started = (task: Task): boolean => task.started_at !== undefined || task.status === 'in-progress';

/** The dispatch check `task edit` runs before a relabel; `home` and `open` are seams for tests. */
export function dispatchCheck(
  slug: string,
  home: string = agentChatHome(),
  open: OpenDatabase = openBriefly,
): (task: Task) => Promise<boolean> {
  return (task) =>
    Promise.resolve(started(task) || spawnNamesTask(path.join(home, 'events.db'), open, slug, task.id));
}
