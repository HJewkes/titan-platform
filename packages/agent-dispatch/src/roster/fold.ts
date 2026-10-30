import type { JournalRow } from '../host/ports.js'
import { launcherOf, type AgentIdentity, type AgentLifecycle, type AgentOrigin, type Launcher } from './types.js'
import { inferWorkRole } from './work-role.js'

/**
 * The durable half of an agent: who it is, not whether it is currently plugged in.
 * A pure projection of the journal; nothing here is stored state.
 */

/** Which row carries the agent id, by kind: the spawn row mints it, the rest cite it. */
export const agentIdOf = (row: JournalRow): string | null => (row.kind === 'agent_spawned' ? row.msgId : row.ref)

const numberOrUndefined = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/** `agent_exited.meta.code` is absent for a signal death, which is not the same as 0. */
const exitFrom = (row: JournalRow): NonNullable<AgentIdentity['exit']> => {
  const code = numberOrUndefined(row.meta.code)
  const costUsd = numberOrUndefined(row.meta.cost_usd)
  return {
    code: code ?? null,
    summary: row.body ?? '',
    ...(costUsd === undefined ? {} : { costUsd }),
    // CC-95: written only by the supervisor's attach verification, so the roster
    // can say `failed` rather than `finished` for a process that never came up.
    ...(row.meta.failed === 'true' ? { failedToStart: true } : {}),
    ...(row.meta.inferred === 'true' ? { inferred: true } : {}),
  }
}

/** Rows written before the marker existed are all supervisor spawns, so the default is not a guess. */
const originOf = (row: JournalRow): AgentOrigin => (row.meta.origin === 'adopted' ? 'adopted' : 'spawned')

/** Generation is 1 unless a teleport stamped the spawn row; for older rows 1 is the truth, not a guess. */
const generationOf = (row: JournalRow): number => {
  const value = Number.parseInt(row.meta.generation ?? '1', 10)
  return Number.isFinite(value) && value > 0 ? value : 1
}

/** Where an identity's spawn row is kept for its `brief` getter: not enumerable, so no frame or spread carries it. */
const SPAWN_ROW = Symbol('spawnRow')

/** One getter for every identity, so they share V8 hidden classes. Not enumerable (CC-1484). */
const BRIEF: PropertyDescriptor = {
  get(this: { [SPAWN_ROW]: JournalRow }) {
    return this[SPAWN_ROW].body ?? ''
  },
  enumerable: false,
}

/** CC-1463: `brief` reads the spawn row's body when asked, so a fold held between reads holds no briefs. */
function spawnedFrom(row: JournalRow, id: string): AgentIdentity {
  const agent = spawnedFields(row, id)
  Object.defineProperty(agent, SPAWN_ROW, { value: row })
  return Object.defineProperty(agent, 'brief', BRIEF) as AgentIdentity
}

const spawnedFields = (row: JournalRow, id: string): Omit<AgentIdentity, 'brief'> => ({
  agentId: id,
  name: row.target ?? row.meta.name ?? '',
  profile: row.meta.profile ?? '',
  state: 'spawning',
  origin: originOf(row),
  spawnedBy: row.actor,
  ...launchedByOf(row),
  spawnedAt: row.ts,
  cwd: row.meta.cwd ?? '',
  isolation: row.meta.isolation ?? '',
  surface: row.meta.surface ?? '',
  sessionId: row.meta.session_id ?? '',
  // CC-100: absent on rows written before the field existed, which reads as the broker's own dir.
  ...(row.meta.config_dir ? { configDir: row.meta.config_dir } : {}),
  ...(row.meta.config_dir_unset === 'true' ? { configDirUnset: true } : {}),
  ...(row.meta.host ? { host: row.meta.host } : {}),
  ...(originOf(row) === 'adopted' && derivedName(row, true) ? { provisionalName: true as const } : {}),
  ...provenanceOf(row),
  lastEventAt: row.ts,
  generation: generationOf(row),
  ...(row.meta.teleport_from ? { teleportFrom: row.meta.teleport_from } : {}),
  ...predecessorOf(row),
})

/**
 * CC-1579: whose work this agent took over, for independence checks. A teleport successor
 * keeps its predecessor's name. A spawn row records `predecessor` only when one was asked for,
 * so its absence means none only on rows from a binary that wrote it: `coordinator_depth`
 * (CC-163) landed after `predecessor` (CC-133) and is on every spawn row since. An adopted
 * session can take over through a handoff without a row saying so, so it stays unknown.
 */
function predecessorOf(row: JournalRow): { predecessor?: string | null } {
  const { meta } = row
  if (meta.teleport_from) return { predecessor: row.target ?? meta.name ?? '' }
  if (meta.predecessor) return { predecessor: meta.predecessor }
  if (originOf(row) === 'adopted' || meta.coordinator_depth === undefined) return {}
  return { predecessor: null }
}

/** CC-1466: the automation that ran a human-requested spawn, beside `spawnedBy` and never in place of it. */
function launchedByOf(row: JournalRow): { launchedBy?: Launcher } {
  const launchedBy = launcherOf(row.meta.launched_by)
  return launchedBy === undefined ? {} : { launchedBy }
}

/** CC-915: rows written before the fields existed get an inferred role and no worktree provenance. */
function provenanceOf(row: JournalRow): Partial<AgentIdentity> {
  const { meta } = row
  const stated = meta.work_role !== undefined && meta.work_role_inferred !== 'true'
  return {
    ...(meta.repo ? { repo: meta.repo } : {}),
    ...(meta.branch ? { branch: meta.branch } : {}),
    ...baseOf(row),
    ...(meta.task ? { task: meta.task } : {}),
    workRole: meta.work_role ?? inferWorkRole(meta.profile ?? '', row.target ?? meta.name ?? ''),
    ...(stated ? {} : { workRoleInferred: true as const }),
  }
}

const baseOf = (row: JournalRow): { base?: { sha: string; ref: string } } =>
  row.meta.base_sha && row.meta.base_ref ? { base: { sha: row.meta.base_sha, ref: row.meta.base_ref } } : {}

/** A resume row carries a base only when it cut a fresh branch; a surviving branch keeps its first one. */
function applyResumeProvenance(agent: AgentIdentity, row: JournalRow): void {
  const base = baseOf(row).base
  if (base !== undefined) agent.base = base
  if (row.meta.repo) agent.repo = row.meta.repo
  if (row.meta.branch) agent.branch = row.meta.branch
}

/** The working-on text a provisional registration sends. */
const DERIVED_WORKING_ON = 'unregistered session in '

/**
 * CC-959: the broker states on each adopt and attach row whether the name was derived. A row
 * without the field predates it, and only its first name can be recognised, by the text a
 * provisional registration sends; a readopt carries that text on under whatever name the
 * session later chose, so the text alone says nothing about a later name.
 */
export const derivedName = (row: JournalRow, firstName: boolean): boolean =>
  row.meta.provisional === undefined
    ? firstName && (row.body ?? '').startsWith(DERIVED_WORKING_ON)
    : row.meta.provisional === 'true'

/** The first name of an adopted identity minted before the broker recorded `provisional`, if it is one. */
function legacyAdoptedName(rows: readonly JournalRow[]): string | undefined {
  const row = rows.find((r) => r.kind === 'agent_spawned')
  if (row === undefined || originOf(row) !== 'adopted' || row.meta.provisional !== undefined) return undefined
  return row.target ?? row.meta.name
}

/** What the fold carries between rows beyond the identity itself. */
interface FoldState {
  agent: AgentIdentity
  legacyName: string | undefined
  /** The recorded exit may be false (CC-454, CC-450); a real one is final. */
  exitInferred: boolean
}

type Reducer = (state: FoldState, row: JournalRow) => void

/** An adopted name follows its latest attach, and so does whether that name was derived or chosen. */
function followAdoptedName({ agent, legacyName }: FoldState, row: JournalRow): void {
  if (agent.origin !== 'adopted') return
  agent.name = row.actor
  if (derivedName(row, legacyName !== undefined && row.actor === legacyName)) agent.provisionalName = true
  else delete agent.provisionalName
}

/** CC-454, CC-450: an inferred exit or a failed start is undone by the registration that lands after it. */
function undoInferredExit(state: FoldState): void {
  if (!state.exitInferred) return
  delete state.agent.exitedAt
  delete state.agent.exit
  state.exitInferred = false
}

/**
 * Presentation is not fixed at spawn: a mode switch resumes the SAME identity into a different
 * surface, carried only by `agent_resumed` and only when a switch changed it. CC-1472: a resume
 * relaunches on one machine, so the agent is wherever the newest one put it.
 */
function applyResume({ agent }: FoldState, row: JournalRow): void {
  if (row.meta.surface) agent.surface = row.meta.surface
  applyResumeProvenance(agent, row)
  if (row.meta.host) agent.host = row.meta.host
  else delete agent.host
  delete agent.exitedAt
  delete agent.detachedAt
}

/** Per-kind effects beyond the lifecycle transition. Kinds absent here only bump `lastEventAt`. */
const REDUCERS: Partial<Record<string, Reducer>> = {
  agent_attached: (state, row) => {
    followAdoptedName(state, row)
    undoInferredExit(state)
    delete state.agent.detachedAt
  },
  agent_detached: ({ agent }, row) => {
    agent.detachedAt = row.ts
  },
  agent_resumed: applyResume,
  agent_exited: (state, row) => {
    state.agent.exit = exitFrom(row)
    state.agent.exitedAt = row.ts
    state.exitInferred = row.meta.inferred === 'true' || row.meta.failed === 'true'
  },
}

/** Lifecycle transitions, keyed by kind. */
const TRANSITIONS: Partial<Record<string, AgentLifecycle>> = {
  agent_attached: 'live',
  agent_detached: 'detached',
  agent_resumed: 'spawning',
  agent_exited: 'exited',
  agent_retired: 'retired',
}

function transitionFor(agent: AgentIdentity, kind: string): AgentLifecycle | undefined {
  const next = TRANSITIONS[kind]
  // CC-450: a socket closing just after the process exited does not reopen a finished agent.
  return kind === 'agent_detached' && agent.exitedAt !== undefined ? 'exited' : next
}

function applyRow(state: FoldState, row: JournalRow): void {
  state.agent.lastEventAt = row.ts
  REDUCERS[row.kind]?.(state, row)
  const next = transitionFor(state.agent, row.kind)
  if (next !== undefined) state.agent.state = next
}

/**
 * Fold one agent's rows, oldest first, into its identity.
 *
 * Pure: no database, no clock, no process. Returns undefined when the rows never establish an
 * identity: an `agent_attached` citing an id with no spawn row is a corrupt or truncated log,
 * and inventing a half-agent from it would put a row on the roster that nothing can resume or retire.
 *
 * `retired` is absorbing. It frees the name, so honouring a later row would resurrect an
 * identity whose name another agent may already hold.
 */
export function foldAgent(rows: readonly JournalRow[]): AgentIdentity | undefined {
  const legacyName = legacyAdoptedName(rows)
  let state: FoldState | undefined

  for (const row of rows) {
    const id = agentIdOf(row)
    if (id === null) continue
    if (row.kind === 'agent_spawned') {
      // A second spawn row for one id cannot happen through the supervisor; the first is the
      // identity everything else already cites.
      state ??= {
        agent: spawnedFrom(row, id),
        legacyName,
        exitInferred: false,
      }
    } else if (state !== undefined && state.agent.state !== 'retired') applyRow(state, row)
  }

  return state?.agent
}

/**
 * When an agent stopped, for the reclaim grace window: its exit, else its last detach.
 * Never `lastEventAt`, which every refused retire's own `isolation_released` row advances.
 */
export const stoppedAt = (agent: Pick<AgentIdentity, 'exitedAt' | 'detachedAt'>): number | undefined =>
  agent.exitedAt ?? agent.detachedAt
