import { z } from "zod";

/**
 * The agent roster and agent graph as a console reads them from the agent-chat
 * broker. Live presence (`/api/sessions`) knows only working, available and
 * blocked; every other state comes from the lifecycle rows in `/api/history`,
 * and `stateSource` says which of the two a row's state was read from.
 */

/** One row of the broker's event log as `/api/history` projects it. `kind` stays a string so new kinds parse. */
export const brokerEvent = z.object({
  msgId: z.string(),
  kind: z.string(),
  from: z.string(),
  text: z.string(),
  at: z.number(),
  meta: z.record(z.string(), z.string()),
});
export type BrokerEvent = z.infer<typeof brokerEvent>;

/** Presence statuses, verbatim from the broker's registry. */
export const PRESENCE_STATES = ["working", "available", "blocked"] as const;

/** The fields of one `/api/sessions` row the roster reads; unknown fields pass through untouched. */
export const brokerSession = z.object({
  name: z.string(),
  workingOn: z.string(),
  cwd: z.string(),
  status: z.enum(PRESENCE_STATES),
  idleMs: z.number(),
  registeredAt: z.number(),
  dnd: z.boolean().optional(),
  provisional: z.boolean().optional(),
  tags: z.array(z.object({ tag: z.string() })).optional(),
  observed: z.object({ gitBranch: z.string().optional(), claudeSessionId: z.string().optional() }).optional(),
  declared: z.record(z.string(), z.string()).optional(),
});
export type BrokerSession = z.infer<typeof brokerSession>;

export const brokerSessions = z.object({ sessions: z.array(brokerSession), brokerUptimeMs: z.number() });
export const brokerHistory = z.object({ items: z.array(brokerEvent) });
/** Lifecycle states folded from history for an agent with no live presence. `failed` is an exit that never started. */
export const HISTORY_STATES = ["spawning", "detached", "exited", "failed", "retired"] as const;
/** History states whose process may still be running; the rest are past. */
export const LIVE_HISTORY_STATES = ["spawning", "detached"] as const;
export const agentState = z.enum([...PRESENCE_STATES, ...HISTORY_STATES]);
export type AgentState = z.infer<typeof agentState>;

export const agentStateSource = z.enum(["presence", "history"]);
export type AgentStateSource = z.infer<typeof agentStateSource>;

/** `claudeSessionId` when Claude Code started the session, else `name@registeredAt` (spawn time for a history-only row). */
export const agentIdSource = z.enum(["claudeSessionId", "nameAtRegisteredAt"]);
export type AgentIdSource = z.infer<typeof agentIdSource>;

/** `spawned` by the supervisor, `adopted` when a human-started session registered, `unknown` when no spawn row is in the window. */
export const agentOrigin = z.enum(["spawned", "adopted", "unknown"]);
export type AgentOrigin = z.infer<typeof agentOrigin>;

/** `session-analytics` prices the transcript; `exit-report` is the cost the agent's own exit row carried. */
export const agentCostSource = z.enum(["session-analytics", "exit-report"]);
export type AgentCostSource = z.infer<typeof agentCostSource>;

export const agentRosterEntry = z.object({
  /** Stable across reconnects: see `idSource`. */
  id: z.string().min(1),
  idSource: agentIdSource,
  name: z.string(),
  /** The broker's durable agent id (the spawn row's msgId); null when no spawn row is in the window. */
  agentId: z.string().nullable(),
  state: agentState,
  stateSource: agentStateSource,
  origin: agentOrigin,
  /** The session's declared line from `chat_register`, or the spawn brief's first line. A claim, not a fact. */
  workingOn: z.string().nullable(),
  cwd: z.string().nullable(),
  gitBranch: z.string().nullable(),
  /** The seat whose name prefix this agent carries; null when no configured prefix matches. */
  seat: z.string().nullable(),
  /** Where the process is presented (`headless`, `iterm-pane`, ...); null for a session the supervisor did not start. */
  surface: z.string().nullable(),
  profile: z.string().nullable(),
  /** A task id the session declared or named in its working line. A claim until TP-838 records it durably. */
  taskId: z.string().nullable(),
  /** The spawner's name; `human` for an adopted session, null when no spawn row is in the window. */
  spawnedBy: z.string().nullable(),
  claudeSessionId: z.string().nullable(),
  registeredAt: z.number().nullable(),
  spawnedAt: z.number().nullable(),
  /** Epoch ms of the newest presence or history signal. */
  lastEventAt: z.number().nullable(),
  /** Presence only: milliseconds since the session last spoke. */
  idleMs: z.number().nullable(),
  /** Presence only: holding pushes. False for a history-only row. */
  dnd: z.boolean(),
  /** Presence only: the name was derived from the directory, not chosen. False for a history-only row. */
  provisional: z.boolean(),
  /** Presence only: tag labels, never authorization. Empty for a history-only row. */
  tags: z.array(z.string()),
  costUsd: z.number().nullable(),
  costSource: agentCostSource.nullable(),
});
export type AgentRosterEntry = z.infer<typeof agentRosterEntry>;

/** How much history the fold saw; the broker caps `/api/history`, so older spawns age out. */
export const historyWindow = z.object({
  events: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  oldestAt: z.number().nullable(),
});
export type HistoryWindow = z.infer<typeof historyWindow>;

export const agentRosterSnapshot = z.object({
  agents: z.array(agentRosterEntry),
  /** Under about 10 s the broker's registry is still refilling after a restart, so missing presence is not death. */
  brokerUptimeMs: z.number().nullable(),
  reconnecting: z.boolean(),
  history: historyWindow,
  generatedAt: z.number(),
});
export type AgentRosterSnapshot = z.infer<typeof agentRosterSnapshot>;

export const ACTIVITY_CATEGORIES = ["message", "question", "notice", "thinking"] as const;
export const activityCategorySchema = z.enum(ACTIVITY_CATEGORIES);
export type ActivityCategory = z.infer<typeof activityCategorySchema>;

export const nodeActivitySchema = z.object({ category: activityCategorySchema, at: z.number() });
export type NodeActivity = z.infer<typeof nodeActivitySchema>;

export const agentGraphNode = z.object({
  /** Stable across a respawn of the same name: the roster id, else the broker agent id, else `name:<name>`. */
  id: z.string().min(1),
  name: z.string(),
  /** The matching roster entry's `id`, so a view can join the two; null for a name with no roster row. */
  rosterId: z.string().nullable(),
  parent: z.string().nullable(),
  /** Spawn-tree column and row from `layoutSpawnTree`; pixels are the renderer's business. */
  depth: z.number().int().nonnegative(),
  row: z.number(),
  activity: nodeActivitySchema.nullable(),
});
export type AgentGraphNode = z.infer<typeof agentGraphNode>;

export const agentGraphEdgeKind = z.enum(["spawned", "message"]);
export type AgentGraphEdgeKind = z.infer<typeof agentGraphEdgeKind>;

/** `from` and `to` are node ids. `spawned` points spawner to child; `message` points sender to recipient, one per ordered pair. */
export const agentGraphEdge = z.object({
  kind: agentGraphEdgeKind,
  from: z.string(),
  to: z.string(),
  count: z.number().int().positive(),
  lastAt: z.number(),
});
export type AgentGraphEdge = z.infer<typeof agentGraphEdge>;

export const agentGraph = z.object({
  /** Ordered by depth, then row. */
  nodes: z.array(agentGraphNode),
  edges: z.array(agentGraphEdge),
  history: historyWindow,
  generatedAt: z.number(),
});
export type AgentGraph = z.infer<typeof agentGraph>;
