import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'vitest'
import { sweepStaleSpills } from './spill-sweep.js'

const DEAD = 4_000_001
const LIVE = 4_000_002
const DAY_MS = 24 * 60 * 60 * 1000
const isAlive = (pid: number) => pid === LIVE

let parent: string

beforeEach(() => {
  parent = mkdtempSync(path.join(tmpdir(), 'spill-sweep-'))
})

afterEach(() => {
  chmodSync(parent, 0o755)
  rmSync(parent, { recursive: true, force: true })
})

function spill(name: string, ageMs = 0): void {
  const dir = path.join(parent, name)
  mkdirSync(dir)
  writeFileSync(path.join(dir, 'chunk-0.pngs'), 'x')
  const when = new Date(Date.now() - ageMs)
  utimesSync(dir, when, when)
}

const left = () => readdirSync(parent).sort()

describe('sweepStaleSpills', () => {
  test('removes the spill of a dead pid', async () => {
    spill(`frame-spill-${DEAD}-abc123`)

    await sweepStaleSpills(parent, { isAlive })

    assert.deepEqual(left(), [])
  })

  test('keeps the spill of a live pid however old it is', async () => {
    spill(`frame-spill-${LIVE}-abc123`, 3 * DAY_MS)

    await sweepStaleSpills(parent, { isAlive })

    assert.deepEqual(left(), [`frame-spill-${LIVE}-abc123`])
  })

  test('keeps the spill of a real other process', async () => {
    spill(`frame-spill-${process.ppid}-abc123`, 3 * DAY_MS)

    await sweepStaleSpills(parent)

    assert.equal(left().length, 1)
  })

  test('removes a pid-less spill over a day old and keeps a newer one', async () => {
    spill('frame-spill-old123', DAY_MS + 60_000)
    spill('frame-spill-new123', DAY_MS - 60_000)

    await sweepStaleSpills(parent, { isAlive })

    assert.deepEqual(left(), ['frame-spill-new123'])
  })

  test('leaves entries that are not spills', async () => {
    spill(`other-${DEAD}-abc123`, 3 * DAY_MS)
    writeFileSync(path.join(parent, 'notes.txt'), 'x')

    await sweepStaleSpills(parent, { isAlive })

    assert.deepEqual(left(), ['notes.txt', `other-${DEAD}-abc123`])
  })

  test('accepts a spill directory that does not exist', async () => {
    await assert.doesNotReject(sweepStaleSpills(path.join(parent, 'missing'), { isAlive }))
  })

  test('survives a deletion that fails', async (t) => {
    if (process.getuid?.() === 0) return t.skip('root ignores directory permissions')
    spill(`frame-spill-${DEAD}-locked`)
    chmodSync(parent, 0o555)

    await assert.doesNotReject(sweepStaleSpills(parent, { isAlive }))

    assert.deepEqual(left(), [`frame-spill-${DEAD}-locked`])
  })
})
