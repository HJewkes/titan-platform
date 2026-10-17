import type { IsolationName, SurfaceName, SurfaceLifetime, AgentRole, ReturnContract, EffortLevel, SettingSource, AgentLifecycle, AgentOrigin, EventKind } from "./names.js";
import type { Subscription } from "./types.js";

export interface AgentProfile {
  name: string
  description: string
  model: string
  /**
   * Passed to --allowed-tools, and THE permission lever. Declare the narrowest
   * set that actually completes the work: too wide leaks authority, too narrow
   * yields an agent that silently produces degraded output.
   */
  allowedTools: string[]
  disallowedTools?: string[]
  isolation: IsolationName
  surface: SurfaceName
  /**
   * Whether this kind of agent's pane goes with it when it ends. Inert for a
   * headless profile, which has no surface to close. See {@link SurfaceLifetime}.
   */
  surfaceLifetime?: SurfaceLifetime
  /** Absent means `worker`: spawning and Remote Control are opted into, never granted by omission. */
  role?: AgentRole
  /** CC-924: spawn and teleport with Remote Control unless the request says otherwise. Coordinator profiles only. */
  remoteControl?: boolean
  /** Absent means the contract is inferred from the name and grants; `none` opts out. */
  returnContract?: ReturnContract | 'none'
  /** Passed as --effort when set; unset leaves the harness default. */
  effort?: EffortLevel
  /** Appended via --append-system-prompt, after the standard peer preamble. */
  promptPrelude: string
  /** Extra MCP servers merged into the generated --mcp-config. */
  mcpServers?: Record<string, unknown>
  /** Load only the generated --mcp-config, dropping user-scope and plugin MCP servers. Absent means on for a headless worker. */
  strictMcpConfig?: boolean
  /** Passed to --setting-sources. Absent means project and local for a worker, and no flag for a coordinator. */
  settingSources?: SettingSource[]
  /** Drop every skill and slash command, which otherwise load into each turn. */
  disableSlashCommands?: boolean
  /** Extra environment for the launched process. Never overrides AGENT_CHAT_* or CLAUDE_CONFIG_DIR. */
  env?: Record<string, string>
  /** Set by the loader, never read from a file: keys in the file that no field here answers to. */
  warnings?: string[]
}

export type RemoteProfile = Omit<AgentProfile, 'env' | 'mcpServers' | 'warnings'>

export interface RemoteLaunch {
  agentId: string
  sessionId: string
  name: string
  profile: RemoteProfile
  brief: string
  preamble: string
  /** CC-281: the predecessor was a human's own session, so its successor has no spawner to report to. */
  adopted?: true
  surface: SurfaceName
  tags?: string[]
  subscriptions?: Subscription[]
  remoteControl?: boolean
  /** CC-951: carried channel targets; the caller's host checks each one before it reaches an argv. */
  channels?: string[]
  /** CC-951: carried permission mode, checked against the same allowlist on the caller's host. */
  permissionMode?: string
  anchor?: string
  /** CC-913: this landing's secret; the only proof a later `teleport_land_failed` came from the caller that armed it. */
  landToken?: string
  /** CC-951: launch now, not after the predecessor exits, and end it only on a later `endSelf` plan. */
  successorFirst?: true
  /** CC-951: set only for a host launcher, which has no predecessor of its own to take these from. */
  cwd?: string
  /** CC-951: the account the predecessor spent, which must exist on the launcher's machine. */
  configDir?: string
  /** CC-1059: a spawn on the default account, so the launching host runs it with CLAUDE_CONFIG_DIR unset. */
  configDirUnset?: true
}

export interface SpawnResultFields {
  ok: boolean
  agentId?: string
  name?: string
  reason?: string
  /** CC-441: the surface refused to launch (iTerm2 down, not macOS), so a headless launch may still work. */
  code?:
    | 'surface_refused'
    | 'spawn_rate_limit'
    | 'machine_headless_limit'
    | 'machine_memory_floor'
    | 'seat_budget_stop'
    | 'seat_spawn_overlap'
    | 'seat_hand_reserve'
    | 'seat_spawn_unprefixed'
    | 'reviewer_account_limit'
    | 'broker_draining'
  /** CC-445: the machine guard's refusals clear as load drops, so the same spawn may be retried later. */
  retryable?: boolean
  /** CC-1179: set with `broker_draining`, the time until the drain lifts at its ttl. */
  retryAfterMs?: number
  warnings?: string[]
  /**
   * The profile's own deny list, echoed back on success. CC-29's finding:
   * a toolset-confined agent cannot report being stuck — the tool is absent
   * from its schema, not refused — so the only place this is knowable with
   * certainty is here, at spawn time, before the agent can fail silently.
   */
  disallowedTools?: string[]
  /** CC-126: set on any resume, so the caller is told whether a conversation actually came back. */
  transcript?: { path: string; found: boolean }
  /** CC-151: the ref and commit a new worktree branch was cut from, so a coordinator can check it. */
  base?: { ref: string; sha: string }
  /** CC-1059: recorded, not launched: the requester launches this on `host`, then reports `spawn_launched`. */
  launch?: RemoteLaunch
  /** CC-1059: the host the agent launches on, when that is not the broker's. */
  host?: string
}

export interface AgentIdentity {
  agentId: string
  name: string
  profile: string
  state: AgentLifecycle
  /** Whether the name and brief are broker-assigned or self-reported. */
  origin: AgentOrigin
  spawnedBy: string
  spawnedAt: number
  brief: string
  cwd: string
  isolation: string
  surface: string
  /** The uuid passed to --session-id. The resume handle. */
  sessionId: string
  /**
   * The Claude config dir this agent was launched on, resolved at spawn (CC-100).
   *
   * Recorded rather than recomputed because it is where the agent's transcript and
   * status-cache actually live: an agent spawned from a session on a dedicated
   * account writes neither under the broker's own dir, so a reader that assumes
   * `CLAUDE_CONFIG_DIR` from its own environment finds nothing and reports "not
   * written yet" forever. Empty for rows written before CC-100.
   */
  configDir?: string
  /** CC-200: the agent runs with `CLAUDE_CONFIG_DIR` unset, so its global config is `~/.claude.json`. */
  configDirUnset?: boolean
  /** CC-1059: the machine the spawn launched on; absent on rows written before it was recorded. */
  host?: string
  /** CC-959: an adopted session's current name was derived from its directory (CC-82), not chosen. */
  provisionalName?: true
  /** CC-915: `owner/name` of the worktree's GitHub origin; absent off GitHub and on older rows. */
  repo?: string
  /** CC-915: the worktree's branch. */
  branch?: string
  /** CC-915: the commit a new worktree branch was cut from; a resume onto a fresh branch replaces it. */
  base?: { sha: string; ref: string }
  /** CC-915: the task id the spawner assigned. */
  task?: string
  /** CC-915: implementer, reviewer, fix-round-N, shepherd-review, planner or other. Set on every folded identity. */
  workRole?: string
  /** CC-915: the role was read from the profile and name, not stated by the spawner. */
  workRoleInferred?: true
  /** Timestamp of the newest row referencing this identity, spawn included. */
  lastEventAt: number
  /** Timestamp of the `agent_exited` row, cleared by a resume; the reclaim grace window's start. */
  exitedAt?: number
  /** Timestamp of the newest `agent_detached` row, cleared by a resume or attach; stands in for `exitedAt` while no exit is recorded. */
  detachedAt?: number
  /**
   * How many teleports deep this identity is: 1 for one that has never
   * teleported, incrementing per hop. Broker-derived, like `teleportFrom` —
   * written by the broker from its own resolution of the predecessor, never from
   * a client-supplied field, which is what makes it lineage rather than a claim.
   */
  generation: number
  /** The immediate predecessor's agentId. The rest of the chain is a walk of these. */
  teleportFrom?: string
  /**
   * `failedToStart` (CC-95) separates "this agent ran and finished" from "this
   * agent never came up". Carried on the exit rather than as a sixth lifecycle
   * because the durable fact IS an exit — the process is gone and the identity is
   * terminal — and only the roster needs to say WHICH kind, which it does without
   * every consumer of `AgentLifecycle` growing a case for it.
   */
  exit?: {
    code: number | null
    summary: string
    costUsd?: number
    failedToStart?: boolean
    /** CC-333: written by the settle timer or a presence check, not by a recorded process exit. */
    inferred?: boolean
  }
}

export interface AgentEventRow {
  kind: EventKind
  ts: number
  actor: string
  target: string | null
  msgId: string | null
  ref: string | null
  body: string | null
  meta: Record<string, string>
}

export interface LoggedEventRow extends AgentEventRow {
  id: number
}

export type AgentListResult = { t: 'agents_result'; agents: AgentIdentity[]; slots?: { held: number; cap: number } };

export type SurfaceResult = {
      t: 'switch_result'
      ok: boolean
      reason?: string
      name?: string
      agentId?: string
      surface?: SurfaceName
      warnings?: string[]
    };

export type SpawnResult = { t: "spawn_result" } & SpawnResultFields;
