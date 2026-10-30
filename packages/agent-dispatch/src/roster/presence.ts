import type { AgentIdentity } from './types.js'

/** Every status the roster can show; `failed` is spawned but never registered: the process is gone and did no work (CC-95). */
export const ROSTER_STATUSES = [
  'starting',
  'running',
  'blocked',
  'stalled?',
  'reconnecting',
  'detached',
  'finished',
  'failed',
  'retired',
] as const

/** How a paired identity and presence should render on the roster. */
export type RosterStatus = (typeof ROSTER_STATUSES)[number]

export interface PresenceInput {
  /** `registry.connFor(name) !== undefined`. */
  connected: boolean
  /** Derived, never stored: the agent has an open `approval_request`. */
  blocked?: boolean
  /** Registry idle time. Omit to opt out of stall reporting entirely. */
  idleMs?: number
  /**
   * Idle time past which a connected agent reads as `stalled?`. No default: the
   * threshold is unvalidated policy and the spec section that was to define it
   * (§11.6) was never written, so a caller that has not chosen one gets no
   * guess — it gets `running`.
   */
  stalledAfterMs?: number
}

export interface RosterEntry {
  agent: AgentIdentity
  status: RosterStatus
  /**
   * Set when lifecycle and presence disagree in a way that should not be
   * possible. Not an event: there is no `agent_state_anomaly` kind, and adding
   * one would unfreeze the SSE contract. Callers surface it on the routing log.
   */
  anomaly?: string
}

/**
 * Pair the durable lifecycle with ephemeral presence.
 *
 * Where the two disagree, presence wins — a live socket is direct evidence and a
 * lifecycle is an inference from rows that may have been missed. That choice is
 * what makes the agents view more truthful than the sessions view: during the
 * reconnect ladder a durable agent can only change presence, never vanish.
 */
export function pairPresence(agent: AgentIdentity, presence: PresenceInput): RosterEntry {
  const { connected, blocked = false, idleMs, stalledAfterMs } = presence

  const connectedStatus = (): RosterStatus => {
    if (blocked) return 'blocked'
    if (stalledAfterMs !== undefined && idleMs !== undefined && idleMs >= stalledAfterMs) return 'stalled?'
    return 'running'
  }

  switch (agent.state) {
    case 'spawning':
      return { agent, status: connected ? connectedStatus() : 'starting' }
    case 'live':
      return { agent, status: connected ? connectedStatus() : 'reconnecting' }
    case 'detached':
      return connected
        ? {
            agent,
            status: connectedStatus(),
            anomaly: 'detached identity holds a live connection; trusting presence',
          }
        : { agent, status: 'detached' }
    case 'exited':
      return connected
        ? {
            agent,
            status: connectedStatus(),
            anomaly: 'exited identity holds a live connection; the exit handler fired while a socket lives',
          }
        : {
            agent,
            status: agent.exit?.failedToStart === true ? 'failed' : 'finished',
          }
    case 'retired':
      return { agent, status: 'retired' }
  }
}
