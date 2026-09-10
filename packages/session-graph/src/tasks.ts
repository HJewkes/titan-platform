import { taskRef } from "@titan-design/session-read";
import type { SessionGraph } from "./graph.js";

/**
 * What a product's task store knows and a transcript cannot state: the task's
 * present title, its initiative, and the status it holds right now rather than
 * the one some command was observed to set. Every field is optional; an omitted
 * or null field leaves whatever the transcripts derived in place.
 */
export interface ResolvedTask {
  initiative?: string | null;
  title?: string | null;
  status?: string | null;
}

/** Resolutions keyed by bare task id (`AW-23`, not `task:AW-23`). */
export type TaskResolution = ReadonlyMap<string, ResolvedTask | null | undefined>;

/**
 * Supplied by the caller, never by this package: session-graph is tier 2 and
 * must not learn where any product keeps its tasks. Called once per pass with
 * every task id at once, because a real resolver reads a store. Returning an id
 * that no transcript mentioned inserts that task; that is how a task nobody
 * worked on gets into the graph.
 */
export type TaskResolver = (taskIds: readonly string[]) => PromiseLike<TaskResolution> | TaskResolution;

export interface TaskEnrichment {
  /** Task ids handed to the resolver. */
  requested: number;
  /** Task rows the resolver wrote. */
  applied: number;
  /** The resolver threw; rows stand as the transcripts left them. */
  failed: boolean;
}

export const NO_ENRICHMENT: TaskEnrichment = Object.freeze({ requested: 0, applied: 0, failed: false });

/**
 * COALESCE gives the resolver precedence over the transcripts on every field it
 * states, and none on the fields it omits: the store is the system of record for
 * a task's present status, while a transcript only witnesses a command that ran.
 */
const UPSERT_TASK = `
  INSERT INTO task (task_ref, task_id, initiative, title, status) VALUES (@taskRef, @taskId, @initiative, @title, @status)
  ON CONFLICT (task_ref) DO UPDATE SET
    initiative = COALESCE(excluded.initiative, initiative),
    title      = COALESCE(excluded.title, title),
    status     = COALESCE(excluded.status, status)`;

export function allTaskIds(graph: SessionGraph): string[] {
  return (graph.db.prepare("SELECT task_id FROM task").all() as { task_id: string }[]).map((r) => r.task_id);
}

/**
 * Enrich task rows from a caller-supplied resolver. Runs outside the delta's
 * transaction because a resolver is async; a crash between the two leaves rows
 * un-enriched, which the next pass corrects. A resolver that throws costs this
 * pass its enrichment and nothing else.
 */
export async function enrichTasks(graph: SessionGraph, resolver: TaskResolver | undefined, taskIds: readonly string[]): Promise<TaskEnrichment> {
  const unique = [...new Set(taskIds)];
  if (!resolver) return NO_ENRICHMENT;
  try {
    const resolved = await resolver(unique);
    return { requested: unique.length, applied: write(graph, resolved), failed: false };
  } catch {
    return { requested: unique.length, applied: 0, failed: true };
  }
}

function write(graph: SessionGraph, resolved: TaskResolution): number {
  const upsert = graph.db.prepare(UPSERT_TASK);
  return graph.db.transaction(() => {
    let applied = 0;
    for (const [taskId, fields] of resolved) {
      if (!fields) continue;
      applied += upsert.run({
        taskRef: taskRef(taskId),
        taskId,
        initiative: fields.initiative ?? null,
        title: fields.title ?? null,
        status: fields.status ?? null,
      }).changes;
    }
    return applied;
  })();
}
