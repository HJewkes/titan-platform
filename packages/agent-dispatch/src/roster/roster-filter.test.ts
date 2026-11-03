import { describe, expect, it } from 'vitest'
import { memoryHost } from '../host/index.js'
import type { JournalRow } from '../host/index.js'
import { AgentLog, callerName, filterRoster, newestByName, viewRoster } from './index.js'
import type { AgentIdentity } from './index.js'

const agent = (name: string, spawnedBy: string): AgentIdentity => ({
  agentId: `id-${name}`,
  name,
  profile: 'implementer',
  state: 'exited',
  origin: 'spawned',
  spawnedBy,
  spawnedAt: 1,
  brief: 'b',
  cwd: '/tmp/roster-filter-nowhere',
  isolation: 'none',
  surface: 'headless',
  sessionId: '',
  lastEventAt: 2,
  generation: 1,
})

// Twelve agents across four spawners; "boss" owns three, two of them under the "cc-" prefix.
const TEN = [
  ...['cc-a', 'cc-b', 'x-c'].map((n) => agent(n, 'boss')),
  ...['cc-d', 'y-e', 'y-f', 'y-g'].map((n) => agent(n, 'other')),
  ...['z-h', 'z-i', 'cc-j'].map((n) => agent(n, 'human')),
  // Contains the prefix without starting with it: a substring match would wrongly keep it.
  agent('old-cc-k', 'human'),
  // Its spawner name contains "boss": a substring match on spawnedBy would wrongly keep it.
  agent('b2-l', 'boss2'),
]
const names = (agents: AgentIdentity[]) => agents.map((a) => a.name)

describe('filterRoster', () => {
  it('keeps only the three agents the caller spawned out of twelve', () => {
    expect(names(filterRoster(TEN, { spawner: 'boss' }))).toEqual(['cc-a', 'cc-b', 'x-c'])
  })

  it('matches the whole spawner name, so boss does not keep boss2 and boss2 keeps only its own', () => {
    expect(names(filterRoster(TEN, { spawner: 'boss' }))).not.toContain('b2-l')
    expect(names(filterRoster(TEN, { spawner: 'boss2' }))).toEqual(['b2-l'])
  })

  it('keeps only agents whose name starts with the prefix', () => {
    expect(names(filterRoster(TEN, { prefix: 'cc-' }))).toEqual(['cc-a', 'cc-b', 'cc-d', 'cc-j'])
  })

  it('combines mine and prefix', () => {
    expect(names(filterRoster(TEN, { spawner: 'boss', prefix: 'cc-' }))).toEqual(['cc-a', 'cc-b'])
  })

  it('counts an agent spawned by a predecessor sharing the callers name as the callers', () => {
    const predecessor = {
      ...agent('boss', 'human'),
      state: 'retired' as const,
    }
    const successor = agent('boss', 'human')
    const child = agent('child', 'boss')
    expect(names(filterRoster([predecessor, successor, child], { spawner: 'boss' }))).toEqual(['child'])
  })

  it('returns everything with no filter', () => {
    expect(filterRoster(TEN, {})).toHaveLength(12)
  })
})

describe('callerName', () => {
  it('fails clearly, pointing at --spawner, when the shell has no session name', () => {
    expect(() => callerName({})).toThrow(/--spawner <your registered name>/)
  })
})

const journalRow = (kind: string, over: Partial<JournalRow> = {}): JournalRow => ({
  kind,
  ts: 1,
  actor: 'boss',
  target: null,
  msgId: null,
  ref: null,
  body: null,
  meta: {},
  ...over,
})

/** A roster folded from journal rows, so a lifecycle the fold gets wrong shows up in the page. */
function foldedRoster(retire: readonly string[]): AgentIdentity[] {
  const { journal } = memoryHost()
  for (const name of ['cc-a', 'cc-b', 'cc-c']) {
    journal.append(journalRow('agent_spawned', { target: name, msgId: `id-${name}`, ts: 10 }))
  }
  for (const name of retire) journal.append(journalRow('agent_retired', { ref: `id-${name}`, ts: 20 }))
  return new AgentLog(journal).roster({ includeRetired: true })
}

describe('viewRoster over a folded journal', () => {
  it('hides a retired agent and counts it, unless retired rows are asked for', () => {
    const agents = foldedRoster(['cc-b'])

    const page = viewRoster(agents, {})
    expect(page.agents.map((a) => a.name).sort()).toEqual(['cc-a', 'cc-c'])
    expect(page.hidden).toEqual({ finished: 0, retired: 1, overLimit: 0 })
    expect(viewRoster(agents, { includeRetired: true }).agents).toHaveLength(3)
  })

  it('counts finished agents separately and cuts the page at the limit', () => {
    const agents = TEN.map((a, i) => ({
      ...a,
      state: i < 2 ? ('exited' as const) : ('live' as const),
    }))

    const page = viewRoster(agents, { limit: 4 })

    expect(page.hidden).toEqual({ finished: 2, retired: 0, overLimit: 6 })
    expect(page.agents).toHaveLength(4)
  })

  it('changes nothing when run on its own output', () => {
    const once = viewRoster(foldedRoster(['cc-a']), { limit: 1 })

    expect(viewRoster(once.agents, { limit: 1 }).agents).toEqual(once.agents)
  })
})

describe('newestByName', () => {
  it('keeps the newest non-retired row of a recurring name', () => {
    const older = { ...agent('seat', 'human'), lastEventAt: 5 }
    const newer = { ...agent('seat', 'human'), lastEventAt: 9 }
    const retired = {
      ...agent('seat', 'human'),
      lastEventAt: 99,
      state: 'retired' as const,
    }

    expect(newestByName([older, newer, retired])).toEqual([newer])
  })
})
