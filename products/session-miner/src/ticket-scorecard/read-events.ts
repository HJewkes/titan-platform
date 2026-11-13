import type { ScorecardSpawn } from "@titan-design/session-analytics";
import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";

/** A spawn or resume linked to a task: through its recorded `meta.task`, or through the session origin (`spawn.link`). */
export interface TaskEvent {
  id: number;
  kind: "agent_spawned" | "agent_resumed";
  taskRef: string;
  spawn: ScorecardSpawn;
  /** `meta.model`; kept beside the spawn so the task row's inputs, and its hash, stay as they were. */
  model: string | null;
}

/** A spawn that recorded no `meta.task`; the session graph's origin link may still name its task. */
export interface UntaskedSpawn {
  id: number;
  sessionId: string | null;
  spawn: ScorecardSpawn;
  model: string | null;
}

const EventRecord = z.object({ id: z.number(), kind: z.enum(["agent_spawned", "agent_resumed"]), ts: z.number(), actor: z.string(), meta: z.string().nullable() });

const SpawnMeta = z.object({
  task: z.string().min(1).optional(),
  session_id: z.string().min(1).optional().catch(undefined),
  launched_by: z.string().optional(),
  dispatch_rule: z.string().optional(),
  model: z.string().min(1).optional().catch(undefined),
});

function parseMeta(meta: string | null): z.infer<typeof SpawnMeta> | null {
  if (meta === null) return null;
  try {
    const parsed = SpawnMeta.safeParse(JSON.parse(meta));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

interface TaskEventRead {
  events: TaskEvent[];
  /** Spawns with no recorded task, in id order. */
  untasked: UntaskedSpawn[];
  maxId: number;
}

/** Every spawn and resume that names a task, and the spawns that name none. The kind index keeps this a short scan (0.14 s for 56k rows). */
export function readTaskEvents(db: Db): TaskEventRead {
  const records = db
    .prepare("SELECT id, kind, ts, actor, meta FROM events WHERE kind IN ('agent_spawned', 'agent_resumed') ORDER BY id")
    .all()
    .map((r) => EventRecord.parse(r));
  const max = db.prepare<[], { m: number | null }>("SELECT max(id) AS m FROM events").get();
  const events: TaskEvent[] = [];
  const untasked: UntaskedSpawn[] = [];
  for (const r of records) {
    const meta = parseMeta(r.meta);
    if (meta === null) continue;
    const spawn = { ts: new Date(r.ts).toISOString(), actor: r.actor, launchedBy: meta.launched_by ?? null, dispatchRule: meta.dispatch_rule ?? null };
    const model = meta.model ?? null;
    if (meta.task !== undefined) events.push({ id: r.id, kind: r.kind, taskRef: meta.task, spawn, model });
    else if (r.kind === "agent_spawned") untasked.push({ id: r.id, sessionId: meta.session_id ?? null, spawn, model });
  }
  return { events, untasked, maxId: max?.m ?? 0 };
}

/** When each spawn the broker refused was asked for (`agent_spawn_refused`, metric 44). */
export function readSpawnRefusalAts(db: Db): string[] {
  return db
    .prepare<[], { ts: number }>("SELECT ts FROM events WHERE kind = 'agent_spawn_refused' ORDER BY id")
    .all()
    .map((r) => new Date(r.ts).toISOString());
}
