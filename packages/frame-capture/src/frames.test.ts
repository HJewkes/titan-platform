import assert from 'node:assert/strict'
import { afterAll as after, beforeAll as before, describe, test } from 'vitest'
import { captureFrames } from './frames.js'
import { serveFixtures, type Served } from './fixtures/serve-fixtures.js'

/** The throws fixture fails from 1 s on, so frames at 0, 1 and 2 s at 1 fps reach it. */
const PAGE = { fps: 1, width: 1920, height: 1080 }
const OPTIONS = { ...PAGE, frames: 3 }
const BROWSER_TIMEOUT_MS = 60_000

let served: Served

before(async () => {
  served = await serveFixtures()
})

after(async () => {
  await served.close()
})

describe('captureFrames', { timeout: BROWSER_TIMEOUT_MS }, () => {
  // Mutation: drop the pageerror listener in openCapturePage; the capture resolves with a blank frame from 1 s on
  // (the spike's blank-frame regression).
  test('a page that throws mid-render fails the capture instead of encoding blank frames', async () => {
    const emitted: number[] = []

    const capture = captureFrames({ ...OPTIONS, url: `${served.url('throws')}&fail-at=1` }, async (i) => void emitted.push(i))

    await assert.rejects(capture, /^Error: page error at frame 1 \(1\.00 s\): throws fixture fails at 1\.00 s$/)
    assert.ok(emitted.length < OPTIONS.frames, `emitted ${emitted.length} frames`)
  })

  // Mutation: attach the pageerror listener after openCapturePage navigates (the round-0 order); the load-time
  // throw is lost and three blank frames are emitted.
  test('a page that throws while loading and then ignores seeks fails the capture before any frame', async () => {
    const emitted: number[] = []

    const capture = captureFrames({ ...OPTIONS, url: served.url('throws-at-load') }, async (i) => void emitted.push(i))

    await assert.rejects(capture, /^Error: page error while loading: throws-at-load fixture fails while loading$/)
    assert.deepEqual(emitted, [])
  })

  // Mutations: waitForMotionApi returns the duration unchecked; NaN rounds to NaN frames and null to 0, and both
  // captures resolve having emitted nothing.
  for (const duration of ['nan', 'null']) {
    test(`a ${duration} __titanMotion.duration fails the capture instead of resolving with no frames`, async () => {
      const capture = captureFrames({ ...PAGE, url: `${served.url('clock')}&duration=${duration}` }, async () => {})

      await assert.rejects(capture, /^Error: window\.__titanMotion\.duration must be a positive number of seconds, got (NaN|null)$/)
    })
  }

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
