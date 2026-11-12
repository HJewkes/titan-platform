import type { Indexes, RowSources } from "./load.js";
import { readGateChanges, readRunChanges } from "./read-factory.js";
import { readPrChanges, readRequestChanges } from "./read-graph.js";
import { resolveTaskRef } from "./read-tasks.js";
import { isoOf, msOf, type Marks } from "./watermarks.js";

export interface DirtySet {
  /** Dispatched tasks whose row may have changed. */
  keys: Set<string>;
  marks: Marks;
}

function addAll(into: Set<string>, keys: Iterable<string | null | undefined>): void {
  for (const key of keys) if (key !== null && key !== undefined) into.add(key);
}

function factoryDirty(s: RowSources, idx: Indexes, before: Marks, keys: Set<string>): Pick<Marks, "runsMs" | "gatesMs"> {
  const runs = readRunChanges(s.factory, isoOf(before.runsMs));
  const gates = readGateChanges(s.factory, isoOf(before.gatesMs));
  addAll(keys, [...runs.runIds, ...gates.runIds].map((runId) => idx.keyByRun.get(runId)));
  return { runsMs: msOf(runs.mark), gatesMs: msOf(gates.mark) };
}

function graphDirty(s: RowSources, idx: Indexes, before: Marks, keys: Set<string>): Pick<Marks, "prsMs" | "requestsMs"> {
  const prs = readPrChanges(s.graph, isoOf(before.prsMs));
  for (const pr of prs.keys) addAll(keys, idx.keysByPr.get(pr) ?? []);
  const requests = readRequestChanges(s.graph, before.requestsMs === 0 ? null : isoOf(before.requestsMs));
  addAll(keys, [...requests.taskIds].map((id) => s.tasks.byId.get(id)));
  return { prsMs: msOf(prs.mark), requestsMs: requests.mark === null ? 0 : msOf(requests.mark) };
}

/** Task files written since the mark, and the tasks they name as the one they follow up. */
function taskFileDirty(s: RowSources, before: Marks, keys: Set<string>): void {
  for (const task of s.tasks.tasks.values()) {
    if (task.mtimeMs <= before.tasksMtimeMs) continue;
    keys.add(task.key);
    addAll(keys, task.followUpOf.map((parent) => resolveTaskRef(s.tasks, parent)));
  }
}

/**
 * Tasks with a new spawn, resume or registration, a run that changed state, a new or resolved gate, a newer task file,
 * a new follow-up naming them, or a PR or cost that changed in the graph. A new labels file touches every task. Only
 * dispatched tasks (a spawn names them) can have a row, so the set keeps those.
 */
export function dirtySet(s: RowSources, idx: Indexes, before: Marks, rebuild: boolean): DirtySet {
  const keys = new Set<string>();
  addAll(keys, idx.events.filter((e) => e.id > before.eventsId).map((e) => resolveTaskRef(s.tasks, e.taskRef)));
  const factory = factoryDirty(s, idx, before, keys);
  const graph = graphDirty(s, idx, before, keys);
  taskFileDirty(s, before, keys);
  const labelsMtimeMs = s.labels?.mtimeMs ?? 0;
  if (rebuild || labelsMtimeMs !== before.labelsMtimeMs) addAll(keys, idx.spawnsByKey.keys());
  const marks = { eventsId: idx.maxEventId, ...factory, ...graph, tasksMtimeMs: s.tasks.maxMtimeMs, labelsMtimeMs };
  return { keys: new Set([...keys].filter((key) => idx.spawnsByKey.has(key))), marks };
}
