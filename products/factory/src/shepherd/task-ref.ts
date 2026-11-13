import { activeWorkRoot } from "@titan-design/app-paths";
import { resolveTaskKey, type TaskKeyIndex, type TaskKeyResolution } from "@titan-design/pm";
import { createRpcClient, liveSource, RpcError, type RpcClient } from "@titan-design/rpc-client";
import { errorMessage } from "../narrow.js";
import { archivedTasks } from "./task-archive.js";

interface InitiativeKeys {
  slug: string;
  task_prefix: string;
  agent_visible: boolean;
  ids: string[];
}

type TaskIndexRpc = {
  "task.keys": { args: Record<string, never>; result: { initiatives: InitiativeKeys[] } };
  "task.list": { args: { all_initiatives: true; status: "all" }; result: { tasks: { id: string; slug: string }[] } };
};

const EXPECTED_FORM = "pass --task <initiative>/<ID>";

/** The key names no task, or the wrong one: the caller refuses the write (exit 65). */
export class TaskKeyRefused extends Error {}

/** active-work did not answer, so nothing can be resolved (exit 69). */
class TaskIndexUnavailable extends Error {}

export interface TaskIndexLookup {
  index: TaskKeyIndex;
  /** Initiatives an agent may read; a report names only these. */
  agentVisible: ReadonlySet<string>;
  /** False when some task files could not be listed, so a key the index lacks may still name a task. */
  complete: boolean;
}

interface LookupOptions {
  origin: string;
  fetch?: typeof fetch;
  /** Where an older daemon's archived task files are listed from; defaults to active-work's own root. */
  activeRoot?: string;
}

/** A key checked against the task index, or one stored as given because no complete index could be read. */
type QualifiedTask = { key: string; verified: true } | { key: string; verified: false; warning: string };

function keysLookup(initiatives: readonly InitiativeKeys[]): TaskIndexLookup {
  const tasks = initiatives.flatMap(({ slug, ids }) => ids.map((id) => ({ id, initiative: slug })));
  return {
    index: { tasks, prefixes: initiatives.map(({ slug, task_prefix }) => ({ initiative: slug, taskPrefix: task_prefix })) },
    agentVisible: new Set(initiatives.filter((item) => item.agent_visible).map((item) => item.slug)),
    complete: true,
  };
}

const unavailable = (error: unknown): TaskIndexUnavailable => new TaskIndexUnavailable(`could not read the active-work task index (${errorMessage(error)})`);

/**
 * A daemon older than `task.keys` still lists open tasks; archived ones are read from file names in its root. It
 * records no task prefix or visibility, so no prefix settles a shared id and no initiative counts as agent-visible.
 */
async function olderDaemonLookup(client: RpcClient<TaskIndexRpc>, activeRoot: string): Promise<TaskIndexLookup> {
  let listed: { id: string; slug: string }[];
  try {
    ({ tasks: listed } = await client.call("task.list", { all_initiatives: true, status: "all" }));
  } catch (error) {
    throw unavailable(error);
  }
  const archived = await archivedTasks(activeRoot);
  const tasks = [...listed.map(({ id, slug }) => ({ id, initiative: slug })), ...(archived ?? [])];
  return { index: { tasks, prefixes: [] }, agentVisible: new Set(), complete: archived !== undefined };
}

/** Every task file's id and every initiative's task prefix, read through the active-work daemon. */
export async function loadTaskIndex(options: LookupOptions): Promise<TaskIndexLookup> {
  const client = createRpcClient<TaskIndexRpc>(liveSource(options));
  try {
    return keysLookup((await client.call("task.keys", {})).initiatives);
  } catch (error) {
    if (!(error instanceof RpcError && error.message === "Unknown command: task.keys")) throw unavailable(error);
  }
  return olderDaemonLookup(client, options.activeRoot ?? activeWorkRoot({ env: process.env }));
}

function refused(task: string, resolved: Exclude<TaskKeyResolution, { ok: true }>): TaskKeyRefused {
  return new TaskKeyRefused(`task key ${JSON.stringify(task)} refused (${resolved.reason}): ${resolved.detail}; ${EXPECTED_FORM}`);
}

const unverified = (task: string, why: string): QualifiedTask => ({ key: task, verified: false, warning: `task key ${JSON.stringify(task)} stored as given, not verified: ${why}` });

const EMPTY_INDEX: TaskKeyIndex = { tasks: [], prefixes: [] };

/**
 * The canonical `<initiative>/<ID>` for a bare, prefixed or repo-qualified key. A key the index positively refuses
 * throws `TaskKeyRefused`; without a complete index only a malformed key is refused, and the rest pass unverified.
 */
export async function qualifyTask(task: string, options: LookupOptions): Promise<QualifiedTask> {
  let lookup: TaskIndexLookup;
  try {
    lookup = await loadTaskIndex(options);
  } catch (error) {
    if (!(error instanceof TaskIndexUnavailable)) throw error;
    const shape = resolveTaskKey(task, EMPTY_INDEX);
    if (!shape.ok && shape.reason === "malformed") throw refused(task, shape);
    return unverified(task, error.message);
  }
  const resolved = resolveTaskKey(task, lookup.index);
  if (resolved.ok) return { key: resolved.key, verified: true };
  if (resolved.reason === "not-found" && !lookup.complete) return unverified(task, "the archived task files could not be listed");
  throw refused(task, resolved);
}
