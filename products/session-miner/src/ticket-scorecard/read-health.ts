import {
  episodeNames,
  filerOf,
  firstDispatch,
  readAgentNames,
  type FactoryHealthInput,
  type FiledTask,
  type ScorecardSpawn,
  type TaskRow,
  type WakeCount,
} from "@titan-design/session-analytics";
import type { Db } from "@titan-design/store-sqlite";
import type { Indexes, RowSources } from "./load.js";
import { readSpawnRefusalAts } from "./read-events.js";
import { labelsFor } from "./read-labels.js";
import { resolveTaskRef } from "./read-tasks.js";

/** Every task file, with who filed it: the recorded field, else the backfill's inferred source label. */
function filedTasks(s: RowSources): FiledTask[] {
  return [...s.tasks.tasks.values()].map((t) => ({
    createdAt: t.createdAt,
    doneAt: t.doneAt,
    filer: filerOf({ source: t.source, filedBy: t.filedBy }, labelsFor(s.labels, t.initiative, t.id).source),
  }));
}

/** The model each task's first dispatch recorded, picked by the same rule the task row picks its dispatch by. */
function dispatchModels(s: RowSources, idx: Indexes): Map<string, string | null> {
  const spawns = new Map<string, (ScorecardSpawn & { model: string | null })[]>();
  for (const event of idx.events) {
    const key = event.kind === "agent_spawned" ? resolveTaskRef(s.tasks, event.taskRef) : null;
    if (key === null) continue;
    const list = spawns.get(key) ?? [];
    list.push({ ...event.spawn, model: event.model });
    spawns.set(key, list);
  }
  return new Map([...spawns].map(([key, list]) => [key, firstDispatch(list)?.model ?? null]));
}

function mergedPrAts(graph: Db): string[] {
  return graph.prepare<[], { at: string }>("SELECT merged_at AS at FROM pr WHERE merged_at IS NOT NULL").all().map((r) => r.at);
}

function gateHoldAts(factory: Db): string[] {
  return factory.prepare<[], { at: string }>("SELECT created_at AS at FROM hitl_gate").all().map((r) => r.at);
}

/** Wake causes the group reads; the rest never reach it. */
const WAKE_CAUSES = ["scheduled_wakeup", "channel_message", "channel_system", "task_notification", "human_typed"];

/** Seat turns per day and wake cause; null when the graph's turns carry no `wake_cause` (an unrolled-up graph). */
function wakeCounts(graph: Db): WakeCount[] | null {
  if (graph.prepare("SELECT 1 FROM pragma_table_info('turn') WHERE name = 'wake_cause'").get() === undefined) return null;
  const names = episodeNames(readAgentNames(graph));
  const rows = graph
    .prepare<[string], { sessionId: string; day: string; cause: string; turns: number }>(
      `SELECT session_id AS sessionId, substr(started_at, 1, 10) AS day, wake_cause AS cause, count(*) AS turns FROM turn
       WHERE wake_cause IN (SELECT value FROM json_each(?)) GROUP BY session_id, day, wake_cause`,
    )
    .all(JSON.stringify(WAKE_CAUSES));
  return rows.flatMap((r) => {
    const seat = names.receivers.get(r.sessionId);
    return seat !== undefined && names.seats.has(seat) ? [{ seat, day: r.day, cause: r.cause, turns: r.turns }] : [];
  });
}

/** The group's raw rows, read from the stores the task rows already read. */
export function factoryHealthInput(s: RowSources, idx: Indexes, rows: readonly TaskRow[]): FactoryHealthInput {
  return {
    rows,
    dispatchModels: dispatchModels(s, idx),
    filed: filedTasks(s),
    mergedPrAts: mergedPrAts(s.graph),
    spawnRefusalAts: readSpawnRefusalAts(s.events),
    gateHoldAts: gateHoldAts(s.factory),
    wakes: wakeCounts(s.graph),
  };
}
