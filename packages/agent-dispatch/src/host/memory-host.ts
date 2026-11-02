import type {
  AdmissionLedger,
  AdmissionRequest,
  AdmissionVerdict,
  AgentJournal,
  DispatchHost,
  JournalRow,
  NamePresence,
  PresencePort,
  ReadmitOutcome,
  RetireHoldPort,
} from './ports.js'

const agentIdOf = (row: JournalRow): string | null => (row.kind === 'agent_spawned' ? row.msgId : row.ref)

export interface MemoryHost extends DispatchHost {
  /** Bind a live connection to a name; `agentId` omitted reads as connected but unbound. */
  connect(name: string, agentId?: string): void
  disconnect(name: string): void
  /** Hold a tree against retire with a reason. */
  hold(tree: string, reason: string): void
  release(tree: string): void
  /** Every `admit` call, in order. */
  admitted(): readonly AdmissionRequest[]
}

function memoryJournal(): AgentJournal {
  const log: JournalRow[] = []
  return {
    append: (row) => {
      log.push(row)
    },
    rows: () => [...log],
    rowsFor: (agentId) => log.filter((row) => agentIdOf(row) === agentId),
  }
}

function memoryPresence(): PresencePort & { connect: MemoryHost['connect']; disconnect: MemoryHost['disconnect'] } {
  const bound = new Map<string, string | null>()
  return {
    connect: (name, agentId) => void bound.set(name, agentId ?? null),
    disconnect: (name) => void bound.delete(name),
    boundAgent: (name) => bound.get(name),
    namePresence: (name, agentId): NamePresence => {
      const holder = bound.get(name)
      if (holder === undefined) return 'none'
      return holder === null || holder === agentId ? 'self' : 'other'
    },
  }
}

function memoryAdmission(): AdmissionLedger & { calls: readonly AdmissionRequest[] } {
  const calls: AdmissionRequest[] = []
  const verdicts = new Map<string, AdmissionVerdict>()
  return {
    calls,
    admit: (request) => {
      calls.push(request)
      const verdict: AdmissionVerdict = { admitted: true }
      verdicts.set(request.agentId, verdict)
      return verdict
    },
    verdict: (agentId) => verdicts.get(agentId),
    readmit: (agentId): ReadmitOutcome => (verdicts.has(agentId) ? 'unchanged' : 'refused'),
  }
}

function memoryRetireHold(): RetireHoldPort & { hold: MemoryHost['hold']; release: MemoryHost['release'] } {
  const holds = new Map<string, string>()
  return {
    hold: (tree, reason) => void holds.set(tree, reason),
    release: (tree) => void holds.delete(tree),
    holdFor: (tree) => holds.get(tree),
  }
}

export function memoryHost(): MemoryHost {
  const presence = memoryPresence()
  const admission = memoryAdmission()
  const retireHold = memoryRetireHold()
  return {
    journal: memoryJournal(),
    presence,
    admission,
    retireHold,
    connect: presence.connect,
    disconnect: presence.disconnect,
    hold: retireHold.hold,
    release: retireHold.release,
    admitted: () => admission.calls,
  }
}
