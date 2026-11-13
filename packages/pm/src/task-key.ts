import { TASK_ID_REGEX } from "./ids.js";

/** One task as the active-work task index lists it: its id and the initiative whose `tasks/` folder holds its file. */
export interface TaskKeyEntry {
  id: string;
  initiative: string;
}

/** An initiative's task-id prefix, as its brief's `task_prefix` records it. */
export interface InitiativePrefix {
  initiative: string;
  taskPrefix: string;
}

export interface TaskKeyIndex {
  tasks: readonly TaskKeyEntry[];
  prefixes: readonly InitiativePrefix[];
}

export type TaskKeyRefusal = "malformed" | "not-found" | "ambiguous" | "wrong-initiative";

export type TaskKeyResolution =
  | { ok: true; key: string; initiative: string; id: string }
  /** `proposed` is the key the id alone resolves to, so a report can name it; a writer still refuses. */
  | { ok: false; reason: TaskKeyRefusal; detail: string; proposed?: string };

interface ParsedKey {
  id: string;
  qualifier?: string;
}

/** `<ID>`, `<qualifier>/<ID>` or `<owner>/<repo>/<ID>`; the segment before the id is the qualifier. */
function parseKey(input: string): ParsedKey | string {
  const segments = input.trim().split("/");
  const id = segments.at(-1) ?? "";
  if (segments.length > 3 || segments.some((segment) => segment === "")) return `${JSON.stringify(input)} is not <initiative>/<ID>`;
  if (!TASK_ID_REGEX.test(id)) return `${JSON.stringify(id)} is not a task id like ABC-12`;
  return segments.length === 1 ? { id } : { id, qualifier: segments.at(-2)! };
}

const idPrefix = (id: string): string => id.slice(0, id.lastIndexOf("-"));

/** The one initiative holding `id`: the only holder, or among several the one whose `task_prefix` issued it. */
function owningInitiative(id: string, holders: readonly string[], index: TaskKeyIndex): string | undefined {
  if (holders.length === 1) return holders[0];
  const issuers = index.prefixes.filter((prefix) => prefix.taskPrefix === idPrefix(id) && holders.includes(prefix.initiative));
  return issuers.length === 1 ? issuers[0]!.initiative : undefined;
}

function unowned(id: string, holders: readonly string[]): TaskKeyResolution {
  if (holders.length === 0) return { ok: false, reason: "not-found", detail: `task ${id} is in no initiative` };
  return { ok: false, reason: "ambiguous", detail: `task ${id} is in ${holders.length} initiatives (${holders.join(", ")})` };
}

/**
 * The canonical task key `<initiative>/<TASK-ID>` for a bare id, a prefixed key or a repo-qualified one. A qualifier
 * that is not the task's initiative is refused, never corrected: the writer must not guess which one was meant.
 */
export function resolveTaskKey(input: string, index: TaskKeyIndex): TaskKeyResolution {
  const parsed = parseKey(input);
  if (typeof parsed === "string") return { ok: false, reason: "malformed", detail: parsed };
  const { id, qualifier } = parsed;
  const holders = [...new Set(index.tasks.filter((task) => task.id === id).map((task) => task.initiative))].sort();
  if (qualifier !== undefined && holders.includes(qualifier)) return { ok: true, key: `${qualifier}/${id}`, initiative: qualifier, id };
  const initiative = owningInitiative(id, holders, index);
  if (initiative === undefined) return unowned(id, holders);
  const key = `${initiative}/${id}`;
  if (qualifier === undefined) return { ok: true, key, initiative, id };
  return { ok: false, reason: "wrong-initiative", detail: `task ${id} is in ${initiative}, not ${qualifier}`, proposed: key };
}
