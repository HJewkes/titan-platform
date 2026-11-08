import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { plantedPop } from './fixtures/planted-pop.js'
import { smoothSweep } from './fixtures/smooth-sweep.js'
import { changedPixels, checkPops, isPop, measureHalving, type RgbaFrame, type SeekFrame } from './pops.js'

const GRID = { start: 0, end: 1, step: 0.25, threshold: 64 }

function scan(seek: SeekFrame<RgbaFrame>) {
  return checkPops({ ...GRID, seek, delta: (a, b) => changedPixels(a, b) })
}

describe('checkPops on synthetic scenes', () => {
  test('a square that mounts at t=0.6 is flagged in the grid step starting at t=0.5', async () => {
    const report = await scan(plantedPop)

    assert.equal(report.findings.length, 1)
    assert.equal(report.findings[0]!.index, 2)
    assert.equal(report.findings[0]!.t, 0.5)
  })

  test('a fast smooth sweep passes the threshold on every step yet has no pops', async () => {
    const report = await scan(smoothSweep)

    assert.equal(report.checked, 4)
    assert.deepEqual(report.findings, [])
  })

  test('a pop in a trailing partial step is still flagged', async () => {
    const report = await checkPops({ ...GRID, end: 0.7, seek: plantedPop, delta: (a, b) => changedPixels(a, b) })

    assert.equal(report.findings.length, 1)
    assert.equal(report.findings[0]!.index, 2)
    assert.equal(report.findings[0]!.t, 0.5)
  })

  test('an async seek is awaited for every grid and sub-step frame', async () => {
    const seen: number[] = []
    const report = await scan(async (t) => {
      seen.push(t)
      return plantedPop(t)
    })

    assert.equal(report.findings[0]?.index, 2)
    assert.equal(seen.length, 5 + 7)
  })
})

describe('the halving decision', () => {
  const steady = { full: 100, half: 61, quarter: 40, eighth: 30 }

  test('a change that keeps more than 0.6 at every halving is a pop', () => {
    assert.equal(isPop(steady), true)
  })

  test('a change that keeps exactly 0.6 of the full step is not a pop', () => {
    assert.equal(isPop({ ...steady, half: 60 }), false)
  })

  test('a change below 2 over the eighth is not a pop, and 2 is', () => {
    const tiny = { full: 3, half: 3, quarter: 3 }

    assert.equal(isPop({ ...tiny, eighth: 1.99 }), false)
    assert.equal(isPop({ ...tiny, eighth: 2 }), true)
  })

  test('measureHalving takes the largest change at each stride', () => {
    const positions = [0, 1, 2, 3, 4, 5, 6, 7, 20]
    const m = measureHalving(positions, (a, b) => Math.abs(b - a))

    assert.deepEqual(m, { full: 20, half: 16, quarter: 14, eighth: 13 })
  })

  test('measureHalving refuses a frame count other than nine', () => {
    assert.throws(() => measureHalving([0, 1], (a, b) => b - a), RangeError)
  })
})
