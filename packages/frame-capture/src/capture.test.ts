import assert from 'node:assert/strict'
import type { Browser } from 'playwright-core'
import { afterAll as after, beforeAll as before, describe, test } from 'vitest'
import { captureFrame, launch, openCapturePage } from './capture.js'
import { serveFixtures, type Served } from './fixtures/serve-fixtures.js'

const VIEWPORT = { width: 640, height: 360 }
const BROWSER_TIMEOUT_MS = 60_000
const EPOCH_MS = Date.UTC(2026, 0, 1)
const WALL_CLOCK_GAP_MS = 250

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

describe('openCapturePage and captureFrame', { timeout: BROWSER_TIMEOUT_MS }, () => {
  // Mutation: patchDate stops replacing window.Date; Date.now and new Date() read the wall clock and drift.
  test('the page reads virtual time, not the wall clock, however long the capture takes', async () => {
    const { page } = await openCapturePage(browser, served.url('clock'), VIEWPORT)
    await captureFrame(page, 1.5)

    await new Promise((resolve) => setTimeout(resolve, WALL_CLOCK_GAP_MS))
    const clocks = await page.evaluate(() => ({ now: Date.now(), date: new Date().getTime(), perf: performance.now() }))

    assert.deepEqual(clocks, { now: EPOCH_MS + 1500, date: EPOCH_MS + 1500, perf: 1500 })
  })

  // Mutations: openCapturePage drops the unloaded-font check (the capture opens), or settleFonts lets the failed
  // load reject (the error names no face).
  test('a declared font face that cannot load fails the capture before frame 0', async () => {
    const opening = openCapturePage(browser, served.url('missing-font'), VIEWPORT)

    await assert.rejects(opening, /^Error: fonts not loaded: .*MissingFace \(error\)/)
  })

  // Mutation: openCapturePage checks fonts even when preloadFonts is false; the opt-out cannot measure anything.
  test('with preloadFonts off, an unloaded face is reported rather than thrown', async () => {
    const { fonts } = await openCapturePage(browser, served.url('missing-font'), { ...VIEWPORT, preloadFonts: false })

    assert.ok(fonts.some((f) => f.family === 'MissingFace' && f.status !== 'loaded'), JSON.stringify(fonts))
  })
})
