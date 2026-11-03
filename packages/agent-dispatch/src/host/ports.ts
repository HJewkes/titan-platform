/**
 * The seams the dispatch fold reads and writes through. Each shape follows what
 * agent-chat's supervisor touches today, so a product adapter (the broker's event
 * store, a registry, a claim table) satisfies a port without translation.
 */

/** One durable lifecycle row. The spawn row mints the agent id; every later row cites it in `ref`. */
export interface JournalRow {
  kind: string
  ts: number
  actor: string
  target: string | null
  msgId: string | null
  ref: string | null
  body: string | null
  meta: Record<string, string>
}

/** The append-only log the roster folds. Order of append is the order of the fold. */
export interface AgentJournal {
  append(row: JournalRow): void
  /** Every row, oldest first. */
  rows(): readonly JournalRow[]
  /** The fold input for one agent: its spawn row and each row citing it, oldest first. */
  rowsFor(agentId: string): readonly JournalRow[]
}

/** How a name's live connection relates to an agent: none, that agent, or another one. */
export type NamePresence = 'none' | 'self' | 'other'

/** Ephemeral presence: dies with a socket, unlike the journal. */
export interface PresencePort {
  /** The agent id bound to the name's connection, `null` when connected but unbound, `undefined` when not connected. */
  boundAgent(name: string): string | null | undefined
  namePresence(name: string, agentId: string): NamePresence
}

export interface AdmissionRequest {
  agentId: string
  name: string
  /** The harness the launch is for, so a verdict can differ per harness. */
  harness?: string
}

export type AdmissionVerdict = { admitted: true } | { admitted: false; reason: string }

/** What a readmit of an already-admitted launch concluded. */
export type ReadmitOutcome = 'readmitted' | 'unchanged' | 'refused'

/** The launch-integrity seam: types only here; the state machine lives behind an adapter. */
export interface AdmissionLedger {
  admit(request: AdmissionRequest): AdmissionVerdict
  verdict(agentId: string): AdmissionVerdict | undefined
  readmit(agentId: string): ReadmitOutcome
}

/** Why a tree must not be reclaimed on retire. Absent is no hold. */
export interface RetireHoldPort {
  holdFor(tree: string): string | undefined
}

export interface DispatchHost {
  journal: AgentJournal
  presence: PresencePort
  admission: AdmissionLedger
  retireHold: RetireHoldPort
}
