import assert from 'node:assert/strict'
import { afterAll as after, beforeAll as before, describe, test } from 'vitest'
import { captureFrames } from './frames.js'
import { serveFixtures, type Served } from './fixtures/serve-fixtures.js'

/** The throws fixture fails from 1 s on, so frames at 0, 1 and 2 s at 1 fps reach it. */
const OPTIONS = { fps: 1, frames: 3, width: 1920, height: 1080 }
const BROWSER_TIMEOUT_MS = 60_000

let served: Served

before(async () => {
  served = await serveFixtures()
})

after(async () => {
  await served.close()
})

describe('captureFrames', { timeout: BROWSER_TIMEOUT_MS }, () => {
  // Mutation: drop the pageerror listener in captureChunk; the capture resolves with a blank frame from 1 s on (the spike's blank-frame regression).
  test('a page that throws mid-render fails the capture instead of encoding blank frames', async () => {
    const emitted: number[] = []

    const capture = captureFrames({ ...OPTIONS, url: `${served.url('throws')}&fail-at=1` }, async (i) => void emitted.push(i))

    await assert.rejects(capture, /^Error: page error at frame 1 \(1\.00 s\): throws fixture fails at 1\.00 s$/)
    assert.ok(emitted.length < OPTIONS.frames, `emitted ${emitted.length} frames`)
  })

  // Mutation: chunks() caps the last chunk at frames - 1; the clean capture drops its last frame.
  test('a page that renders cleanly captures every frame', async () => {
    const emitted: number[] = []

    const result = await captureFrames({ ...OPTIONS, url: served.url('throws') }, async (i) => void emitted.push(i))

    assert.equal(result.frames, OPTIONS.frames)
    assert.deepEqual(emitted, [0, 1, 2])
  })

  // Mutation: orderedSink hands frames to the sink as workers finish them; the out-of-order chunk shows up here.
  test('frames from parallel workers reach the sink in index order', async () => {
    const emitted: number[] = []

    await captureFrames({ ...OPTIONS, frames: 6, fps: 2, workers: 3, url: served.url('throws') }, async (i) => void emitted.push(i))

    assert.deepEqual(emitted, [0, 1, 2, 3, 4, 5])
  })
})
