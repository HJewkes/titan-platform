import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { memoryHost, sqliteHost, type DispatchHost, type JournalRow, type MemoryHost } from './index.js'

const cacheRoot = path.join(homedir(), '.cache', 'agent-dispatch-host-tests')
mkdirSync(cacheRoot, { recursive: true })
const dirs: string[] = []
const dbPath = (): string => {
  const dir = mkdtempSync(path.join(cacheRoot, 'db-'))
  dirs.push(dir)
  return path.join(dir, 'journal.db')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

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

const hosts: [string, () => MemoryHost][] = [
  ['memoryHost', memoryHost],
  ['sqliteHost', () => sqliteHost(dbPath())],
]

describe.each(hosts)('%s', (_name, makeHost) => {
  it('satisfies every port', () => {
    const host: DispatchHost = makeHost()
    expect(typeof host.journal.append).toBe('function')
    expect(typeof host.presence.namePresence).toBe('function')
    expect(typeof host.admission.admit).toBe('function')
    expect(typeof host.retireHold.holdFor).toBe('function')
  })

  it('hands the fold every row of one agent in append order and no other', () => {
    const { journal } = makeHost()
    journal.append(row('agent_spawned', { msgId: 'a1' }))
    journal.append(row('agent_spawned', { msgId: 'b1' }))
    journal.append(row('observe_running', { ref: 'a1' }))
    journal.append(row('agent_exited', { ref: 'a1', ts: 3 }))

    expect(journal.rowsFor('a1').map((r) => r.kind)).toEqual(['agent_spawned', 'observe_running', 'agent_exited'])
    expect(journal.rowsFor('b1')).toHaveLength(1)
    expect(journal.rows()).toHaveLength(4)
  })

  it('reads a name as none, self or other by the agent its connection is bound to', () => {
    const { presence, connect, disconnect } = makeHost()
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
    const host = makeHost()
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
    const host = makeHost()
    expect(host.retireHold.holdFor('/t')).toBeUndefined()
    host.hold('/t', 'claimed')
    expect(host.retireHold.holdFor('/t')).toBe('claimed')
    host.release('/t')
    expect(host.retireHold.holdFor('/t')).toBeUndefined()
  })
})

describe('sqliteHost across a restart', () => {
  it('folds the same rows in append order after the database is reopened', () => {
    const file = dbPath()
    const first = sqliteHost(file)
    first.journal.append(row('agent_spawned', { msgId: 'a1', ts: 9, meta: { role: 'worker' } }))
    first.journal.append(row('observe_running', { ref: 'a1', ts: 2 }))
    first.journal.append(row('agent_spawned', { msgId: 'b1', ts: 5 }))
    first.journal.append(row('agent_exited', { ref: 'a1', ts: 2, body: 'done' }))
    first.close()

    const second = sqliteHost(file)
    expect(second.journal.rowsFor('a1').map((r) => r.kind)).toEqual(['agent_spawned', 'observe_running', 'agent_exited'])
    expect(second.journal.rows().map((r) => r.kind)).toEqual([
      'agent_spawned',
      'observe_running',
      'agent_spawned',
      'agent_exited',
    ])
    expect(second.journal.rows()[0]).toEqual(row('agent_spawned', { msgId: 'a1', ts: 9, meta: { role: 'worker' } }))
    second.close()
  })

  it('keeps appending after a reopen behind the rows already stored', () => {
    const file = dbPath()
    const first = sqliteHost(file)
    first.journal.append(row('agent_spawned', { msgId: 'a1', ts: 5 }))
    first.close()

    const second = sqliteHost(file)
    second.journal.append(row('agent_exited', { ref: 'a1', ts: 1 }))
    expect(second.journal.rowsFor('a1').map((r) => r.kind)).toEqual(['agent_spawned', 'agent_exited'])
    second.close()
  })

  it('does not carry presence or holds over a restart', () => {
    const file = dbPath()
    const first = sqliteHost(file)
    first.connect('w', 'a1')
    first.hold('/t', 'claimed')
    first.close()

    const second = sqliteHost(file)
    expect(second.presence.boundAgent('w')).toBeUndefined()
    expect(second.retireHold.holdFor('/t')).toBeUndefined()
    second.close()
  })
})
