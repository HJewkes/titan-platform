import { describe, expect, it } from 'vitest'
import { memoryHost, type DispatchHost, type JournalRow } from './index.js'

const row = (kind: string, fields: Partial<JournalRow> = {}): JournalRow => ({
  kind,
  ts: 1,
  actor: 'supervisor',
  target: null,
  msgId: null,
  ref: null,
  body: null,
  meta: {},
  ...fields,
})

describe('memoryHost', () => {
  it('satisfies every port', () => {
    const host: DispatchHost = memoryHost()
    expect(typeof host.journal.append).toBe('function')
    expect(typeof host.presence.namePresence).toBe('function')
    expect(typeof host.admission.admit).toBe('function')
    expect(typeof host.retireHold.holdFor).toBe('function')
  })

  it('hands the fold every row of one agent in append order and no other', () => {
    const { journal } = memoryHost()
    journal.append(row('agent_spawned', { msgId: 'a1' }))
    journal.append(row('agent_spawned', { msgId: 'b1' }))
    journal.append(row('observe_running', { ref: 'a1' }))
    journal.append(row('agent_exited', { ref: 'a1', ts: 3 }))

    expect(journal.rowsFor('a1').map((r) => r.kind)).toEqual(['agent_spawned', 'observe_running', 'agent_exited'])
    expect(journal.rowsFor('b1')).toHaveLength(1)
    expect(journal.rows()).toHaveLength(4)
  })

  it('reads a name as none, self or other by the agent its connection is bound to', () => {
    const { presence, connect, disconnect } = memoryHost()
    expect(presence.namePresence('w', 'a1')).toBe('none')

    connect('w', 'a1')
    expect(presence.namePresence('w', 'a1')).toBe('self')
    expect(presence.namePresence('w', 'a2')).toBe('other')

    connect('w')
    expect(presence.namePresence('w', 'a2')).toBe('self')

    disconnect('w')
    expect(presence.boundAgent('w')).toBeUndefined()
  })

  it('always admits and records each call', () => {
    const host = memoryHost()
    const first = host.admission.admit({ agentId: 'a1', name: 'w' })
    const second = host.admission.admit({ agentId: 'a2', name: 'x', harness: 'codex' })

    expect(first).toEqual({ admitted: true })
    expect(second).toEqual({ admitted: true })
    expect(host.admitted().map((r) => r.agentId)).toEqual(['a1', 'a2'])
    expect(host.admission.verdict('a1')).toEqual({ admitted: true })
    expect(host.admission.readmit('a1')).toBe('unchanged')
    expect(host.admission.readmit('never')).toBe('refused')
  })

  it('reports a hold with its reason until released', () => {
    const host = memoryHost()
    expect(host.retireHold.holdFor('/t')).toBeUndefined()
    host.hold('/t', 'claimed')
    expect(host.retireHold.holdFor('/t')).toBe('claimed')
    host.release('/t')
    expect(host.retireHold.holdFor('/t')).toBeUndefined()
  })
})
