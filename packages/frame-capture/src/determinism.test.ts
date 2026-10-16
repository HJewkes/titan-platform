import assert from 'node:assert/strict'
import type { Browser } from 'playwright-core'
import { afterAll as after, beforeAll as before, describe, test } from 'vitest'
import { captureFrame, launch, openCapturePage } from './capture.js'
import { serveFixtures, type Served } from './fixtures/serve-fixtures.js'

const FPS = 30
const FRAMES = 30
const VIEWPORT = { width: 1920, height: 1080 }
const BROWSER_TIMEOUT_MS = 120_000

let served: Served
let browser: Browser

before(async () => {
  served = await serveFixtures()
  browser = await launch()
}, BROWSER_TIMEOUT_MS)

after(async () => {
  await browser.close()
  await served.close()
})

/**
 * Virtual time only moves forward, so a capture jumps by skipping ahead, as each parallel chunk does to its
 * first frame. A fixed set of irregular forward jumps, so a failure reproduces.
 */
function jumpingForward(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i).filter((i) => i % 5 === 0 || i % 7 === 3)
}

/** Captures `order` on a fresh page and returns the PNGs by frame index. */
async function captureInOrder(order: readonly number[]): Promise<Buffer[]> {
  const { page } = await openCapturePage(browser, served.url('drift'), VIEWPORT)
  const pngs: Buffer[] = []
  for (const i of order) pngs[i] = await captureFrame(page, i / FPS)
  await page.context().close()
  return pngs
}

describe('capture determinism', { timeout: BROWSER_TIMEOUT_MS }, () => {
  // Mutation: seedMathRandom left out of the init script; the two page loads draw different box colours.
  // Dropping --disable-partial-raster from launch() is not caught here: on the headless shell it passed 3 of 3
  // runs without the flag. The flag stays for the measurement in launch()'s comment.
  test('a frame reached by a jump matches the same frame from a sweep', async () => {
    const sweep = await captureInOrder(Array.from({ length: FRAMES }, (_, i) => i))
    const order = jumpingForward(FRAMES)
    const jumped = await captureInOrder(order)

    const differing = order.filter((i) => !jumped[i]?.equals(sweep[i] ?? Buffer.alloc(0)))

    assert.deepEqual(differing, [])
  })
})
