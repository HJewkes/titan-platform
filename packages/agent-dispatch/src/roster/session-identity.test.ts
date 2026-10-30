import { describe, expect, it } from 'vitest'
import { memoryHost } from '../host/index.js'
import type { JournalRow } from '../host/index.js'
import { AgentLog } from './index.js'

/**
 * An ordinary human-started session gets a durable identity. The journal carries the durable half
 * (an id, the session id, the rows a succession edge hangs on) and never the ephemeral half
 * (presence, a pid). These cases drive the rows the broker writes for a registration through the fold.
 */

let clock = 100

const row = (kind: string, over: Partial<JournalRow> = {}): JournalRow => ({
  kind,
  ts: (clock += 10),
  actor: 'alpha',
  target: null,
  msgId: null,
  ref: null,
  body: null,
  meta: {},
  ...over,
})

const adopt = (id: string, name: string, meta: Record<string, string> = {}): JournalRow =>
  row('agent_spawned', {
    actor: 'human',
    target: name,
    msgId: id,
    body: 'CC-30',
    meta: {
      origin: 'adopted',
      session_id: 'sess-abc',
      cwd: '/tmp/project',
      provisional: 'false',
      ...meta,
    },
  })

const attach = (id: string, name: string, meta: Record<string, string> = {}): JournalRow =>
  row('agent_attached', {
    actor: name,
    ref: id,
    body: 'CC-30',
    meta: { provisional: 'false', ...meta },
  })

const rosterOf = (...rows: JournalRow[]) => {
  const { journal } = memoryHost()
  for (const r of rows) journal.append(r)
  return {
    agents: new AgentLog(journal),
    roster: new AgentLog(journal).roster(),
  }
}

describe('adopting a human-started session', () => {
  it('gives it an identity the log can name, attributed to the human who started it', () => {
    const { roster } = rosterOf(adopt('a1', 'alpha'), attach('a1', 'alpha'))

    expect(roster).toHaveLength(1)
    expect(roster[0]).toMatchObject({
      agentId: 'a1',
      name: 'alpha',
      origin: 'adopted',
      spawnedBy: 'human',
    })
  })

  it('records the session id, which is what makes the transcript findable', () => {
    expect(rosterOf(adopt('a1', 'alpha')).roster[0]?.sessionId).toBe('sess-abc')
  })

  it('records the account the session observed itself running on, and none when it observed none', () => {
    const observed = rosterOf(adopt('a1', 'alpha', { config_dir: '/profiles/personal' })).roster[0]
    const unobserved = rosterOf(adopt('a2', 'beta')).roster[0]

    expect(observed?.configDir).toBe('/profiles/personal')
    expect(unobserved?.configDir).toBeUndefined()
  })

  it('marks a derived name, and clears the mark when the session names itself', () => {
    const derived = rosterOf(adopt('a1', 'agent-x', { provisional: 'true' }))
    expect(derived.roster[0]?.provisionalName).toBe(true)

    const chosen = rosterOf(adopt('a1', 'agent-x', { provisional: 'true' }), attach('a1', 'chosen'))
    expect(chosen.roster[0]).toMatchObject({ name: 'chosen' })
    expect(chosen.roster[0]?.provisionalName).toBeUndefined()
  })

  it('takes the derived name as chosen once the session registers it without the flag', () => {
    const { roster } = rosterOf(
      adopt('a1', 'agent-x', { provisional: 'true' }),
      attach('a1', 'agent-x', { provisional: 'false' }),
    )

    expect(roster[0]?.provisionalName).toBeUndefined()
  })

  it('re-attaches to the identity it already has instead of minting a second', () => {
    const { roster } = rosterOf(
      adopt('a1', 'alpha'),
      attach('a1', 'alpha'),
      row('agent_detached', { ref: 'a1' }),
      attach('a1', 'alpha'),
    )

    expect(roster).toHaveLength(1)
    expect(roster[0]).toMatchObject({ agentId: 'a1', state: 'live' })
  })

  it('keeps the identity when presence ends, which is the half that is durable', () => {
    const { roster } = rosterOf(adopt('a1', 'alpha'), attach('a1', 'alpha'), row('agent_detached', { ref: 'a1' }))

    expect(roster[0]?.state).toBe('detached')
  })

  it('follows a rename without leaving a second identity behind', () => {
    const { roster } = rosterOf(adopt('a1', 'alpha'), attach('a1', 'alpha-two'))

    expect(roster).toHaveLength(1)
    expect(roster[0]?.name).toBe('alpha-two')
  })
})

describe('what adoption must not become', () => {
  it('does not hand over a spawned agent to a session quoting its session id', () => {
    const spawned = row('agent_spawned', {
      actor: 'human',
      target: 'scout',
      msgId: 'spawned1',
      meta: { session_id: 'sess-abc', profile: 'explorer' },
    })
    const { agents } = rosterOf(spawned)

    expect(agents.bySession('sess-abc')).toBeUndefined()
    expect(agents.get('spawned1')?.state).toBe('spawning')
  })

  it('finds an adopted identity by its session id', () => {
    const { agents } = rosterOf(adopt('a1', 'alpha'), attach('a1', 'alpha'))

    expect(agents.bySession('sess-abc')?.agentId).toBe('a1')
  })

  it('carries no pid on the identity, because a pid is presence', () => {
    const { roster } = rosterOf(adopt('a1', 'alpha'), attach('a1', 'alpha'))

    expect(JSON.stringify(roster)).not.toMatch(/pid/i)
  })
})
