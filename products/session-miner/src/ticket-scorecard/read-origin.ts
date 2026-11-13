import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import type { TaskEvent, UntaskedSpawn } from "./read-events.js";

/** How the spawns with no recorded `meta.task` fared against the session graph's origin link. */
export interface OriginLinkCounts {
  /** The origin names exactly one task: linked, marked `inferred:<task_source>`. */
  linked: number;
  /** The origin names several tasks: left unlinked. */
  several: number;
  /** The origin was resolved and names no task: left unlinked. */
  none: number;
  /** No resolved origin row for the session, or the spawn recorded no session: left unlinked. */
  noOrigin: number;
}

interface OriginLink {
  taskIds: string[];
  source: string;
}

const OriginRow = z.object({ session_id: z.string(), task_ids: z.string().nullable(), task_source: z.string() });
const TaskIds = z.array(z.string().min(1));

function idsOf(text: string | null): string[] {
  if (text === null) return [];
  try {
    return TaskIds.catch([]).parse(JSON.parse(text));
  } catch {
    return [];
  }
}

/** The resolved origin link of each session asked for. A null `task_source` is a row no task-aware resolver has answered yet. */
function readOriginLinks(graph: Db, sessionIds: readonly string[]): Map<string, OriginLink> {
  const rows = graph
    .prepare<[string], unknown>("SELECT session_id, task_ids, task_source FROM session_origin WHERE task_source IS NOT NULL AND session_id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(sessionIds));
  const links = new Map<string, OriginLink>();
  for (const raw of rows) {
    const r = OriginRow.parse(raw);
    links.set(r.session_id, { taskIds: [...new Set(idsOf(r.task_ids))], source: r.task_source });
  }
  return links;
}

/**
 * Task events for spawns that recorded no task, through the link the session graph already resolved for the spawned
 * session. Only a link naming exactly one task counts; the heuristic id is the graph's own `task_source`.
 */
export function originLinkedEvents(graph: Db, untasked: readonly UntaskedSpawn[]): { events: TaskEvent[]; counts: OriginLinkCounts } {
  const sessionIds = [...new Set(untasked.flatMap((u) => (u.sessionId === null ? [] : [u.sessionId])))];
  const links = readOriginLinks(graph, sessionIds);
  const counts: OriginLinkCounts = { linked: 0, several: 0, none: 0, noOrigin: 0 };
  const events: TaskEvent[] = [];
  for (const u of untasked) {
    const link = u.sessionId === null ? undefined : links.get(u.sessionId);
    if (link === undefined) counts.noOrigin++;
    else if (link.taskIds.length === 0) counts.none++;
    else if (link.taskIds.length > 1) counts.several++;
    else {
      counts.linked++;
      events.push({ id: u.id, kind: "agent_spawned", taskRef: link.taskIds[0]!, spawn: { ...u.spawn, link: `inferred:${link.source}` }, model: u.model });
    }
  }
  return { events, counts };
}
