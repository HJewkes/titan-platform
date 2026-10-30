import type { AgentJournal, JournalRow } from '../host/ports.js'
import { agentIdOf, foldAgent } from './fold.js'
import type { AgentIdentity } from './types.js'

/** The kinds that belong to an agent's lifecycle; any other journal row would invent an agent that was never spawned. */
const AGENT_KINDS: ReadonlySet<string> = new Set([
  'agent_spawned',
  'agent_attached',
  'agent_detached',
  'agent_resumed',
  'agent_exited',
  'agent_retired',
  'agent_handoff',
  'agent_stood_down',
  'isolation_allocated',
  'isolation_released',
  'isolation_parked',
])

const isAgentRow = (row: JournalRow): boolean => AGENT_KINDS.has(row.kind)

/** Group rows by the agent id they carry, preserving log order within each group. */
export function groupByAgent(rows: readonly JournalRow[]): Map<string, JournalRow[]> {
  const groups = new Map<string, JournalRow[]>()
  for (const row of rows) {
    const id = agentIdOf(row)
    if (id === null) continue
    const group = groups.get(id)
    if (group) group.push(row)
    else groups.set(id, [row])
  }
  return groups
}

/**
 * CC-1453: the broker launched this identity from a plan it can rebuild: a
 * spawn, or any teleport successor. A successor of a hand-started session is
 * recorded as adopted, because it keeps that session's inherited configuration,
 * but it was still launched here, so it resolves by name like a spawn does.
 */
export const launchedByBroker = (agent: AgentIdentity): boolean =>
  agent.origin === 'spawned' || agent.teleportFrom !== undefined

/** Every identity the rows establish, frozen because a reused fold hands the same ones to every caller. */
function foldAll(rows: readonly JournalRow[]): readonly AgentIdentity[] {
  const agents: AgentIdentity[] = []
  for (const group of groupByAgent(rows).values()) {
    const agent = foldAgent(group)
    if (agent) agents.push(deepFreeze(agent))
  }
  // Newest first: a roster is read top-down and the agent just spawned is the
  // one being looked for.
  return agents.sort((a, b) => b.spawnedAt - a.spawnedAt)
}

/** `exit` and `base` are an identity's only nested objects. */
function deepFreeze(agent: AgentIdentity): AgentIdentity {
  if (agent.exit) Object.freeze(agent.exit)
  if (agent.base) Object.freeze(agent.base)
  return Object.freeze(agent)
}

/**
 * Query surface over the identity rows. Every call re-reads the rows, so it can
 * never drift from the log the way a cached aggregate would.
 *
 * CC-1463: the fold is reused while the read returns the same rows. The log only
 * appends, so the same count ending in the same row object is the same list; a
 * store that builds fresh rows per read (a fake, a tail read inside a transaction)
 * just refolds.
 */
export class AgentLog {
  private folded:
    | {
        count: number
        last: JournalRow | undefined
        agents: readonly AgentIdentity[]
      }
    | undefined

  constructor(private readonly journal: AgentJournal) {}

  private agentEvents(): JournalRow[] {
    return this.journal.rows().filter(isAgentRow)
  }

  private agentEventsFor(agentId: string): JournalRow[] {
    return this.journal.rowsFor(agentId).filter(isAgentRow)
  }

  private all(): AgentIdentity[] {
    const rows = this.agentEvents()
    const last = rows.at(-1)
    if (this.folded?.count !== rows.length || this.folded.last !== last)
      this.folded = { count: rows.length, last, agents: foldAll(rows) }
    return this.folded.agents.slice()
  }

  roster(opts: { includeRetired?: boolean } = {}): AgentIdentity[] {
    const agents = this.all()
    return opts.includeRetired ? agents : agents.filter((a) => a.state !== 'retired')
  }

  get(id: string): AgentIdentity | undefined {
    return foldAgent(this.agentEventsFor(id))
  }

  /**
   * The most recently spawned identity still holding `name`.
   *
   * Only identities the broker launched are matched (`launchedByBroker`). This
   * is what `retire` and `resume` resolve through, and neither is meaningful for
   * a session the broker did not launch: there is no launch plan to relaunch and
   * no isolation to release. It also keeps them out of the name lease below —
   * nothing can bring a hand-started session back under its name, so leasing one
   * past its process would block a spawn on that name forever.
   */
  byName(name: string): AgentIdentity | undefined {
    return this.all().find((a) => a.name === name && launchedByBroker(a) && a.state !== 'retired')
  }

  /**
   * CC-408: a newer identity under the same name, retired or not.
   *
   * Teleport successors keep the name, so once the newest is retired `byName`
   * falls back to an older generation; resuming that would wake a stale session.
   * CC-959: an adopted successor counts too. A seat restarted by hand is adopted,
   * and `byName` cannot see it, so it would otherwise resume the older spawned row.
   * Not one whose name was derived from its directory: a session merely opened in
   * an agent's worktree takes the agent's name without meaning to replace it.
   */
  supersededBy(agent: AgentIdentity): AgentIdentity | undefined {
    return this.all().find(
      (a) => a.name === agent.name && a.spawnedAt > agent.spawnedAt && a.provisionalName !== true && !this.neverRan(a),
    )
  }

  /** CC-1453: a teleport successor retired before it ever attached never held the conversation, so it supersedes nothing. */
  private neverRan(agent: AgentIdentity): boolean {
    return agent.state === 'retired' && !this.agentEventsFor(agent.agentId).some((row) => row.kind === 'agent_attached')
  }

  /**
   * The identity adopted for a Claude Code session id, so a session that
   * reconnects or outlives a broker restart re-attaches instead of accumulating
   * one identity per registration.
   *
   * Matches adopted identities only. A spawned agent's session id is recorded in
   * the log, where every session on the machine can read it, so matching one
   * would make adoption a way to claim an agent's identity by quoting a field —
   * the hole `BrokerCore.claimable` closes for agent ids.
   */
  bySession(sessionId: string): AgentIdentity | undefined {
    if (sessionId === '') return undefined
    return this.all().find((a) => a.origin === 'adopted' && a.sessionId === sessionId && a.state !== 'retired')
  }

  /**
   * The uniqueness the schema no longer provides: a name is leased for as long
   * as any non-retired identity holds it, so a detached or finished agent still
   * owns its name and stays resumable under it.
   *
   * CC-124: except one that failed to start. It never ran, so there is nothing
   * to resume, and holding its name made the obvious retry refuse until someone
   * retired a corpse by hand.
   */
  nameIsClaimed(name: string): boolean {
    return this.nameHolder(name) !== undefined
  }

  /** The identity holding the name lease `nameIsClaimed` describes, so a refusal can say who it is. */
  nameHolder(name: string): AgentIdentity | undefined {
    return this.all().find(
      (a) =>
        a.name === name &&
        launchedByBroker(a) &&
        a.state !== 'retired' &&
        !(a.state === 'exited' && a.exit?.failedToStart === true),
    )
  }

  /**
   * Has this identity stood down for a successor?
   *
   * A query, not a lifecycle state, and deliberately: standing down lasts
   * seconds, so making it a state would put it in `pairPresence`'s switch and
   * force a rendering decision for a condition nobody will ever see on screen.
   */
  stoodDown(agentId: string): boolean {
    return this.agentEvents().some((row) => row.kind === 'agent_stood_down' && row.ref === agentId)
  }

  /** The identity this one teleported into, if it has one. */
  successorOf(agentId: string): AgentIdentity | undefined {
    return this.all().find((a) => a.teleportFrom === agentId)
  }

  /** An identity followed by each teleport successor in turn, oldest first; empty when it is unknown. */
  lineageFrom(agentId: string): AgentIdentity[] {
    const agents = this.all()
    const line: AgentIdentity[] = []
    let next = agents.find((a) => a.agentId === agentId)
    while (next !== undefined && !line.includes(next)) {
      line.push(next)
      const from = next.agentId
      next = agents.find((a) => a.teleportFrom === from)
    }
    return line
  }

  /**
   * The raw `meta` of an identity's spawn row.
   *
   * For the fields `AgentIdentity` deliberately does not model — `depth` and
   * `parent` are enforcement inputs rather than things a roster should show, and
   * teleport has to carry both across UNCHANGED (succession is not branching,
   * so an inherited depth is the whole point).
   */
  spawnMeta(agentId: string): Record<string, string> {
    const row = this.agentEvents().find((r) => r.kind === 'agent_spawned' && r.msgId === agentId)
    return row?.meta ?? {}
  }
}
