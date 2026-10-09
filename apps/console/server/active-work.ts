import { z } from "zod";
import { DeliverableSchema } from "@titan-design/pm";
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
  // Edge and deliverable fields arrive from active-work 0.23 on; an older daemon carries edges as tags only.
  parent: z.string().optional(),
  dep: z.array(z.string()).optional(),
  deliverables: z.array(z.string()).optional(),
  status: z.enum(["open", "done"]),
  notes: z.string().optional(),
  done_when: z.string().optional(),
  updated: z.string(),
});

const artifactBranch = z.object({ repo: z.string(), name: z.string(), note: z.string().optional() });

const artifactWorktree = z.object({ path: z.string(), repo: z.string(), branch: z.string().optional(), holding: z.string().optional(), note: z.string().optional() });

const prInfo = z.object({ number: z.number(), state: z.string(), title: z.string(), url: z.string(), checks: z.string().optional() });

const reference = z.object({ slug: z.string(), source: z.enum(["task", "session", "artifacts"]), file: z.string(), field: z.string(), text: z.string() });

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
  "artifact.list": z.object({ items: z.array(z.object({ slug: z.string(), artifacts: z.object({ branches: z.array(artifactBranch), worktrees: z.array(artifactWorktree) }) })) }),
  /** Runs `gh` once per registered branch, so only a one-task read may call it. */
  "artifact.status": z.object({
    branches: z.array(artifactBranch.extend({ present: z.boolean(), pr: prInfo.nullable() })),
    worktrees: z.array(artifactWorktree.extend({ branch: z.string().nullable(), present: z.boolean(), pr: z.number().optional() })),
  }),
  "context.graph": z.object({ references: z.array(reference) }),
  /** The platform-wide deliverables registry; a daemon older than active-work 0.23 has no such command. */
  "deliverable.list": z.object({ deliverables: z.array(DeliverableSchema) }),
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

/** Schema drift in an upstream answer: every upstream client reports it with this message shape and EXIT.SOFTWARE. */
export function unexpectedShape(upstream: string): Error {
  return failure(`${upstream} answered an unexpected shape`, EXIT.SOFTWARE);
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
      if (!parsed.success) throw unexpectedShape(`active-work ${command}`);
      return parsed.data as ReadResult<typeof command>;
    },
  };
}
