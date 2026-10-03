import { z } from "zod";
import { EXIT } from "@titan-design/registry";
import { liveSource } from "@titan-design/rpc-client";

const stat = z.object({ files: z.number(), bytes: z.number(), newest_mtime: z.string().nullable() });

const initiativeItem = z.object({
  slug: z.string(),
  title: z.string(),
  state: z.enum(["focused", "backburner", "paused", "done"]),
  rank: z.number().optional(),
  ship_target: z.string().optional(),
  updated: z.string(),
});

const task = z.object({
  slug: z.string(),
  id: z.string(),
  title: z.string(),
  priority: z.number(),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  estimate: z.number().optional(),
  tags: z.array(z.string()).optional(),
  updated: z.string(),
});

const inventoryInitiative = z.object({
  slug: z.string(),
  human_only: z.boolean(),
  total: stat,
  classes: z.object({ tasks: stat, sessions: stat, notes: stat, sources: stat, nested_sources: stat }),
});

const session = z.object({
  filename: z.string(),
  frontmatter: z.object({ started: z.string(), ended: z.string(), track: z.string() }),
  first_line: z.string(),
});

const loop = z.object({
  ref: z.string(),
  text: z.string(),
  kind: z.enum(["task", "pr", "prose"]),
  target_ref: z.string().optional(),
  session_file: z.string(),
  opened_at: z.string(),
});

const note = z.object({ id: z.string(), filename: z.string(), kind: z.string(), title: z.string(), created: z.string(), mtime: z.string().nullable() });

const source = z.object({ id: z.string(), filename: z.string(), type: z.string(), title: z.string(), mtime: z.string().nullable() });

/** The active-work reads the console may call, with the part of each answer it uses. There is no write in this list. */
const READS = {
  list: z.object({
    sections: z.array(z.object({ heading: z.string(), items: z.array(initiativeItem) })),
    parse_errors: z.array(z.object({ slug: z.string(), error: z.string() })),
  }),
  "task.list": z.object({ tasks: z.array(task) }),
  inventory: z.object({ initiatives: z.array(inventoryInitiative), human_only_known: z.boolean() }),
  "session.list": z.object({ sessions: z.array(session) }),
  loops: z.object({ open: z.array(loop) }),
  "note.list": z.object({ notes: z.array(note) }),
  "source.list": z.object({ sources: z.array(source) }),
  "source.read": z.object({ content: z.string(), truncated: z.boolean() }),
};

export type ReadName = keyof typeof READS;
export type ReadResult<K extends ReadName> = z.infer<(typeof READS)[K]>;
export type WireInitiative = z.infer<typeof initiativeItem>;
export type WireTask = z.infer<typeof task>;
export type WireInventoryInitiative = z.infer<typeof inventoryInitiative>;

export interface ActiveWork {
  /** Rejects with an error that carries a sysexits `code` when the daemon is down, refuses, or answers another shape. */
  read<K extends ReadName>(command: K, args?: Record<string, unknown>): Promise<ReadResult<K>>;
}

const READ_TIMEOUT_MS = 10_000;

export function failure(message: string, code: number): Error {
  return Object.assign(new Error(message), { code });
}

/** Calls the active-work daemon's `/rpc` on loopback. It never starts the daemon. */
export function activeWorkClient(port: number, timeoutMs: number = READ_TIMEOUT_MS): ActiveWork {
  const source = liveSource({
    origin: `http://127.0.0.1:${port}`,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  });
  return {
    async read(command, args = {}) {
      const envelope = await source.call(command, args);
      if (!envelope.ok) throw failure(`active-work ${command}: ${envelope.error}`, envelope.code);
      const parsed = READS[command].safeParse(envelope.data);
      if (!parsed.success) throw failure(`active-work ${command} answered an unexpected shape`, EXIT.SOFTWARE);
      return parsed.data as ReadResult<typeof command>;
    },
  };
}
