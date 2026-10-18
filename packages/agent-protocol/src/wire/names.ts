import { z } from "zod";

export const SURFACE_NAMES = ["headless", "iterm-pane", "iterm-tab", "iterm-window", "tmux-window"] as const;
export const ISOLATION_NAMES = ["none", "worktree", "file-ownership", "toolset-limited"] as const;
export const SurfaceNameSchema = z.enum(SURFACE_NAMES);
export const IsolationNameSchema = z.enum(ISOLATION_NAMES);
export type SurfaceName = z.infer<typeof SurfaceNameSchema>;
export type IsolationName = z.infer<typeof IsolationNameSchema>;

export const SUBSCRIBABLE_KINDS = [
  'registered',
  'deregistered',
  'agent_spawned',
  'agent_attached',
  'agent_detached',
  'agent_resumed',
  'agent_exited',
  'agent_retired',
  'agent_spawn_refused',
] as const;

export const WAKE_SOURCES = ['watchdog', 'shepherd'] as const;

export const SubscribableKindSchema = z.enum(SUBSCRIBABLE_KINDS);
export const WakeSourceSchema = z.enum(WAKE_SOURCES);
export type SubscribableKind = z.infer<typeof SubscribableKindSchema>;
export type WakeSource = z.infer<typeof WakeSourceSchema>;

export const SURFACE_LIFETIMES = ['close-on-exit', 'keep'] as const;
export const SurfaceLifetimeSchema = z.enum(SURFACE_LIFETIMES);
export type SurfaceLifetime = z.infer<typeof SurfaceLifetimeSchema>;

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const EffortLevelSchema = z.enum(EFFORT_LEVELS);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

export const AGENT_ROLES = ['coordinator', 'worker'] as const;
export const AgentRoleSchema = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const SETTING_SOURCES = ['user', 'project', 'local'] as const;
export const SettingSourceSchema = z.enum(SETTING_SOURCES);
export type SettingSource = z.infer<typeof SettingSourceSchema>;

export const RETURN_CONTRACTS = ['implementer', 'reviewer'] as const;
export const ReturnContractSchema = z.enum(RETURN_CONTRACTS);
export type ReturnContract = z.infer<typeof ReturnContractSchema>;

export const AGENT_LIFECYCLES = ['spawning', 'live', 'detached', 'exited', 'retired'] as const;
export const AgentLifecycleSchema = z.enum(AGENT_LIFECYCLES);
export type AgentLifecycle = z.infer<typeof AgentLifecycleSchema>;

export const AGENT_ORIGINS = ['spawned', 'adopted'] as const;
export const AgentOriginSchema = z.enum(AGENT_ORIGINS);
export type AgentOrigin = z.infer<typeof AgentOriginSchema>;

export const EVENT_KINDS = [
  'message',
  'broadcast',
  'question',
  'notice',
  'answer',
  'resolution',
  'approval_request',
  'registered',
  'deregistered',
  'route_failed',
  // Agent identity lifecycle. Landed ahead of any agent code on purpose: this
  // union is enumerated in the SSE contract, so adding kinds later unfreezes
  // that contract and re-serialises everything built against it.
  //
  // Id convention, and it is load-bearing rather than cosmetic: `agent_spawned`
  // puts the AGENT ID in `msg_id`, and every later row puts it in `ref`. That
  // makes both hot queries hit indexes that already exist — "the spawn record
  // for agent X" on events_msg_id, "everything that happened to agent X" on
  // events_ref.
  'agent_spawned',
  'agent_attached',
  'agent_detached',
  'agent_resumed',
  'agent_exited',
  'agent_retired',
  // Teleport (CC-20). Two kinds rather than one with a `meta.phase`: "wrote its
  // handoff" and "the countdown ran out" are different instants, and a query for
  // either should not have to filter on a stringly field.
  'agent_handoff',
  'agent_stood_down',
  'isolation_allocated',
  'isolation_released',
  // CC-282: a finished agent's worktree was removed and its branch kept, for `agent resume` to re-create.
  'isolation_parked',
  // Refusals are events rather than just `reason` strings on a reply: they are
  // the security-relevant thing, and must be in the log whether or not anyone
  // was watching at the time.
  'agent_spawn_refused',
  'verdict_refused',
  // CC-22. A message an agent composed and wants delivered with its human's
  // authority. It sits in the human queue like a `question` and is closed by the
  // same `resolution` row, so approving and declining both reuse machinery that
  // already retires an item — an `endorse_verdict` kind would leave it open
  // forever until someone also taught CLOSED about it.
  'endorse_request',
  // Autonomy slice 3. The decider's answer to a human-queue question, written
  // only by the broker for the one configured decider identity. It leaves the
  // question open so the human can still overrule it with `answer`.
  'decided',
  // CC-1056: the M0 criterion-3 instrument. Written by the seat's tool hooks, never by the broker.
  'seat_blocked',
  'seat_unblocked',
  'seat_activity',
  // CC-1092: a seat's AskUserQuestion denied by its pre hook, so no block ever opened.
  'seat_ask_denied',
] as const;
export const EventKindSchema = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof EventKindSchema>;
