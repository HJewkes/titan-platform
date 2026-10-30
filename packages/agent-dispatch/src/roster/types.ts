/** The identity shapes the roster folds into. Mirrors agent-chat's protocol so a product adapter needs no translation. */

export const AGENT_LIFECYCLES = ['spawning', 'live', 'detached', 'exited', 'retired'] as const
export type AgentLifecycle = (typeof AGENT_LIFECYCLES)[number]

export const AGENT_ORIGINS = ['spawned', 'adopted'] as const
export type AgentOrigin = (typeof AGENT_ORIGINS)[number]

export const LAUNCHERS = ['seat-watchdog', 'shepherd'] as const
export type Launcher = (typeof LAUNCHERS)[number]

export const launcherOf = (value: unknown): Launcher | undefined => LAUNCHERS.find((known) => known === value)

/** The principal that stands for a person at the keyboard. */
export const HUMAN = 'human'

export interface AgentExit {
  code: number | null
  summary: string
  costUsd?: number
  failedToStart?: boolean
  inferred?: boolean
}

/** A durable agent identity: who it is, never whether it is plugged in. */
export interface AgentIdentity {
  agentId: string
  name: string
  profile: string
  state: AgentLifecycle
  origin: AgentOrigin
  spawnedBy: string
  launchedBy?: Launcher
  spawnedAt: number
  /** Read off the spawn row on demand; not enumerable, so a serialised roster leaves it out. */
  brief: string
  cwd: string
  isolation: string
  surface: string
  sessionId: string
  configDir?: string
  configDirUnset?: boolean
  host?: string
  provisionalName?: true
  repo?: string
  branch?: string
  base?: { sha: string; ref: string }
  task?: string
  workRole?: string
  workRoleInferred?: true
  lastEventAt: number
  exitedAt?: number
  detachedAt?: number
  generation: number
  teleportFrom?: string
  /** `null` when the spawn row records none; absent when the row cannot say. */
  predecessor?: string | null
  exit?: AgentExit
}

/** What an agent-list page asks the roster to cut. */
export interface RosterView {
  spawner?: string
  prefix?: string
  includeFinished?: boolean
  includeRetired?: boolean
  limit?: number
}

/** How many rows each cut dropped, so a reader knows the page is not the whole roster. */
export interface RosterHidden {
  finished: number
  retired: number
  overLimit: number
}

/** A message read back from the log, as a report to carry into a successor's brief. */
export interface QueueItem {
  msgId: string
  kind: string
  from: string
  text: string
  at: number
  meta: Record<string, string>
}
