import type { ScorecardSpawn } from "@titan-design/session-analytics";
import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";

/** A spawn or resume whose meta names a task, as agent-chat's `assignmentMeta` writes it. */
export interface TaskEvent {
  id: number;
  kind: "agent_spawned" | "agent_resumed";
  taskRef: string;
  spawn: ScorecardSpawn;
}

const EventRecord = z.object({ id: z.number(), kind: z.enum(["agent_spawned", "agent_resumed"]), ts: z.number(), actor: z.string(), meta: z.string().nullable() });

const SpawnMeta = z.object({
  task: z.string().min(1).optional(),
  launched_by: z.string().optional(),
  dispatch_rule: z.string().optional(),
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

/** Every spawn and resume that names a task. The kind index keeps this a short scan (0.14 s for 56k rows). */
export function readTaskEvents(db: Db): { events: TaskEvent[]; maxId: number } {
  const records = db
    .prepare("SELECT id, kind, ts, actor, meta FROM events WHERE kind IN ('agent_spawned', 'agent_resumed') ORDER BY id")
    .all()
    .map((r) => EventRecord.parse(r));
  const max = db.prepare<[], { m: number | null }>("SELECT max(id) AS m FROM events").get();
  const events: TaskEvent[] = [];
  for (const r of records) {
    const meta = parseMeta(r.meta);
    if (meta?.task === undefined) continue;
    const spawn = { ts: new Date(r.ts).toISOString(), actor: r.actor, launchedBy: meta.launched_by ?? null, dispatchRule: meta.dispatch_rule ?? null };
    events.push({ id: r.id, kind: r.kind, taskRef: meta.task, spawn });
  }
  return { events, maxId: max?.m ?? 0 };
}
