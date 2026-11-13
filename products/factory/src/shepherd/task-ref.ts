import { resolveTaskKey, type TaskKeyIndex } from "@titan-design/pm";
import { createRpcClient, liveSource } from "@titan-design/rpc-client";
import { errorMessage } from "../narrow.js";

interface InitiativeItem {
  slug: string;
  task_prefix: string;
  agent_visible: boolean;
}

type TaskIndexRpc = {
  "task.list": { args: { all_initiatives: true; status: "all" }; result: { tasks: { id: string; slug: string }[] } };
  list: { args: Record<string, never>; result: { sections: { items: InitiativeItem[] }[] } };
};

const EXPECTED_FORM = "pass --task <initiative>/<ID>";

/** The key names no task, or the wrong one: the caller refuses the write (exit 65). */
export class TaskKeyRefused extends Error {}

/** active-work did not answer, so nothing can be resolved (exit 69). */
export class TaskIndexUnavailable extends Error {}

export interface TaskIndexLookup {
  index: TaskKeyIndex;
  /** Initiatives an agent may read; a report names only these. */
  agentVisible: ReadonlySet<string>;
}

interface LookupOptions {
  origin: string;
  fetch?: typeof fetch;
}

/** Every task and every initiative's task prefix, read through the active-work daemon. */
export async function loadTaskIndex(options: LookupOptions): Promise<TaskIndexLookup> {
  const client = createRpcClient<TaskIndexRpc>(liveSource(options));
  try {
    const [{ tasks }, { sections }] = await Promise.all([client.call("task.list", { all_initiatives: true, status: "all" }), client.call("list", {})]);
    const initiatives = sections.flatMap((section) => section.items);
    return {
      index: { tasks: tasks.map(({ id, slug }) => ({ id, initiative: slug })), prefixes: initiatives.map(({ slug, task_prefix }) => ({ initiative: slug, taskPrefix: task_prefix })) },
      agentVisible: new Set(initiatives.filter((item) => item.agent_visible).map((item) => item.slug)),
    };
  } catch (error) {
    throw new TaskIndexUnavailable(`could not read the active-work task index (${errorMessage(error)}); ${EXPECTED_FORM}`);
  }
}

/** The canonical `<initiative>/<ID>` for a bare, prefixed or repo-qualified key; a key that resolves to no one task is refused, never corrected. */
export async function qualifyTask(task: string, options: LookupOptions): Promise<string> {
  const resolved = resolveTaskKey(task, (await loadTaskIndex(options)).index);
  if (resolved.ok) return resolved.key;
  throw new TaskKeyRefused(`task key ${JSON.stringify(task)} refused (${resolved.reason}): ${resolved.detail}; ${EXPECTED_FORM}`);
}
