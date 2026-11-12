import type { ScorecardSpawn } from "@titan-design/session-analytics";
import type { Db } from "@titan-design/store-sqlite";
import type { PerRunRecord, PerRunSource } from "./per-run.js";
import { readTaskEvents, type TaskEvent } from "./read-events.js";
import { readRegistrations, type Registration } from "./read-factory.js";
import { prKey } from "./read-graph.js";
import { readLabels, type LabelLoad } from "./read-labels.js";
import { loadTasks, resolveTaskRef, type TaskFacts, type TaskLoad } from "./read-tasks.js";
import { openReadOnly, type SourceName } from "./sources.js";

export interface ScorecardPaths {
  eventsDb: string;
  factoryDb: string;
  graphDb: string;
  initiativesRoot: string;
  initiatives: readonly string[];
  labelsFile: string;
}

/** Every source the job reads; null where the store is absent, which reads as not measured. */
export interface Sources {
  events: Db | null;
  factory: Db | null;
  graph: Db | null;
  tasks: TaskLoad | null;
  labels: LabelLoad | null;
  perRun: Map<string, PerRunRecord> | null;
}

export async function openSources(paths: ScorecardPaths, perRun: PerRunSource): Promise<Sources> {
  const factory = openReadOnly(paths.factoryDb);
  const records = factory === null ? null : await perRun(paths.factoryDb);
  const tasks = loadTasks(paths.initiativesRoot, paths.initiatives);
  return {
    events: openReadOnly(paths.eventsDb),
    factory,
    graph: openReadOnly(paths.graphDb),
    tasks: tasks.missing.length === paths.initiatives.length ? null : tasks,
    labels: readLabels(paths.labelsFile),
    perRun: records === null ? null : new Map(records.map((r) => [r.runId, r])),
  };
}

export function closeSources(sources: Sources): void {
  for (const db of [sources.events, sources.factory, sources.graph]) db?.close();
}

export function notMeasured(sources: Sources): SourceName[] {
  const missing: [SourceName, unknown][] = [
    ["events", sources.events],
    ["factory", sources.factory],
    ["shepherd-per-run", sources.perRun],
    ["graph", sources.graph],
    ["tasks", sources.tasks],
    ["labels", sources.labels],
  ];
  return missing.filter(([, value]) => value === null).map(([name]) => name);
}

/** The sources a task row needs, all present. */
export interface RowSources {
  events: Db;
  factory: Db;
  graph: Db;
  tasks: TaskLoad;
  labels: LabelLoad | null;
  perRun: Map<string, PerRunRecord>;
}

export function rowSources(s: Sources): RowSources | null {
  if (s.events === null || s.factory === null || s.graph === null || s.tasks === null || s.perRun === null) return null;
  return { events: s.events, factory: s.factory, graph: s.graph, tasks: s.tasks, labels: s.labels, perRun: s.perRun };
}

/** The joins built once per run, each keyed on a task key (`initiative/ID`). */
export interface Indexes {
  events: TaskEvent[];
  maxEventId: number;
  spawnsByKey: Map<string, ScorecardSpawn[]>;
  regsByKey: Map<string, Registration[]>;
  keyByRun: Map<string, string>;
  keysByPr: Map<string, string[]>;
  /** Follow-up tasks by the bare id of the task they follow up. */
  childrenOf: Map<string, TaskFacts[]>;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

export function buildIndexes(s: RowSources): Indexes {
  const { events, maxId } = readTaskEvents(s.events);
  const idx: Indexes = { events, maxEventId: maxId, spawnsByKey: new Map(), regsByKey: new Map(), keyByRun: new Map(), keysByPr: new Map(), childrenOf: new Map() };
  for (const event of events) {
    const key = resolveTaskRef(s.tasks, event.taskRef);
    if (key !== null && event.kind === "agent_spawned") push(idx.spawnsByKey, key, event.spawn);
  }
  for (const reg of readRegistrations(s.factory)) {
    const key = resolveTaskRef(s.tasks, reg.taskRef);
    if (key === null) continue;
    push(idx.regsByKey, key, reg);
    idx.keyByRun.set(reg.runId, key);
    if (reg.pr !== null) push(idx.keysByPr, prKey(reg.repo, reg.pr), key);
  }
  for (const task of s.tasks.tasks.values()) for (const parent of task.followUpOf) push(idx.childrenOf, parent, task);
  return idx;
}
