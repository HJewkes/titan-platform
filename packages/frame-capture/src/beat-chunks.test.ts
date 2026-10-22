import assert from 'node:assert/strict'
import { afterAll as after, beforeAll as before, describe, test } from 'vitest'
import { beatChunks, captureFrames, type FramesOptions } from './frames.js'
import { serveFixtures, type Served } from './fixtures/serve-fixtures.js'

/** Six half-second beats of four frames each; the fixture page's duration is 3 s. */
const FPS = 8
const BEAT_S = 0.5
const BEAT_STARTS_S = [0, 0.5, 1, 1.5, 2, 2.5]
const WORKERS = 16
const VIEWPORT = { width: 320, height: 180 }
const BROWSER_TIMEOUT_MS = 120_000

let served: Served

before(async () => {
  served = await serveFixtures()
})

after(async () => {
  await served.close()
})

async function render(options: Partial<FramesOptions>): Promise<Buffer[]> {
  const pngs: Buffer[] = []
  const url = `${served.url('beats')}&beat-s=${BEAT_S}`
  await captureFrames({ ...VIEWPORT, fps: FPS, url, ...options }, async (i, png) => void (pngs[i] = png))
  return pngs
}

function differingFrames(a: readonly Buffer[], b: readonly Buffer[]): number[] {
  assert.equal(a.length, b.length)
  return a.flatMap((png, i) => (png.equals(b[i] ?? Buffer.alloc(0)) ? [] : [i]))
}

describe('beatChunks', () => {
  test('packs whole beats into balanced chunks', () => {
    assert.deepEqual(beatChunks([0, 4, 8, 12, 16, 20], 24, 3), [[0, 8], [8, 16], [16, 24]])
  })

  test('runs one chunk per beat when there are more workers than beats', () => {
    assert.deepEqual(beatChunks([0, 10, 12], 20, 16), [[0, 10], [10, 12], [12, 20]])
  })

  test('cuts at the beat nearest an even split when beats are uneven', () => {
    assert.deepEqual(beatChunks([0, 2, 9, 11], 20, 2), [[0, 9], [9, 20]])
  })
})

describe('parallel capture on beat boundaries', { timeout: BROWSER_TIMEOUT_MS }, () => {
  // Mutation: chunks() ignores beatStartsS and splits by frame count; chunks then start mid-beat, where the
  // page's eased label has no history, and those frames differ from the sequential render.
  test(`a ${WORKERS}-worker render with beat starts matches a sequential render frame for frame`, async () => {
    const sequential = await render({})
    const parallel = await render({ workers: WORKERS, beatStartsS: BEAT_STARTS_S })

    assert.equal(parallel.length, FPS * 3)
    assert.deepEqual(differingFrames(parallel, sequential), [])
  })

  // Guards the test above against a fixture that renders the same frames whatever the chunking.
  test(`a ${WORKERS}-worker render chunked by frame count differs from a sequential render`, async () => {
    const sequential = await render({})
    const byCount = await render({ workers: WORKERS })

    assert.notDeepEqual(differingFrames(byCount, sequential), [])
  })
})
