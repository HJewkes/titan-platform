import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Browser, Page } from 'playwright-core'
import { afterAll as after, beforeAll as before, describe, test } from 'vitest'
import { captureFrame, launch, openCapturePage } from './capture.js'
import { serveFixtures, type Served } from './fixtures/serve-fixtures.js'

const VIEWPORT = { width: 1200, height: 180 }
const BROWSER_TIMEOUT_MS = 60_000
const REAL_TIME_GAP_MS = 400

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

async function openAnimations(): Promise<Page> {
  const { page } = await openCapturePage(browser, new URL('animations.html', served.url('')).href, VIEWPORT)
  return page
}

/** How far each box has moved, in whole px: the transform of #spin and #late, the left of #glide. */
function offsets(page: Page): Promise<{ spin: number; glide: number; late: number }> {
  return page.evaluate(() => {
    const style = (id: string) => getComputedStyle(document.getElementById(id) ?? document.body)
    const translateX = (id: string) => Math.round(new DOMMatrix(style(id).transform).m41)
    return { spin: translateX('spin'), glide: Math.round(parseFloat(style('glide').left)), late: translateX('late') }
  })
}

describe('virtual time', { timeout: BROWSER_TIMEOUT_MS }, () => {
  // Mutation: the Date proxy's apply trap returns the real Date(); the string names today, not the virtual clock.
  test('Date() called without new returns the virtual time as a string', async () => {
    const page = await openAnimations()
    await page.evaluate(() => window.__virtualTime.advanceTo(1500))

    const [called, constructed, iso] = await page.evaluate(() => [Date(), new Date().toString(), new Date().toISOString()])

    assert.equal(iso, '2026-01-01T00:00:01.500Z')
    assert.equal(called, constructed)
  })

  // Mutation: patchTimeline left out of the init script; document.timeline reads the browser's real clock.
  test('document.timeline.currentTime reads virtual time', async () => {
    const page = await openAnimations()
    await page.evaluate(() => window.__virtualTime.advanceTo(1500))

    const timelineMs = await page.evaluate(() => document.timeline.currentTime)

    assert.equal(timelineMs, 1500)
  })

  // Mutation: syncAnimations does nothing; the animations run on real time and stand wherever the browser got to.
  // Mutation: captureFrame skips its sync after ready(); #glide's transition starts a frame late, at 0.7 s.
  test('CSS animations and transitions sit where virtual time puts them', async () => {
    const page = await openAnimations()

    for (const t of [0, 0.2, 0.7]) await captureFrame(page, t)

    assert.deepEqual(await offsets(page), { spin: 700, glide: 500, late: 400 })
  })

  // Mutation: syncAnimations does nothing; real time passes between the two captures, so the boxes move.
  test('two captures of the same frame match with real time passing between them', async () => {
    const first = await captureFrame(await openAnimations(), 0.5)
    const later = await openAnimations()
    await sleep(REAL_TIME_GAP_MS)

    const second = await captureFrame(later, 0.5)

    assert.ok(first.equals(second), 'the frame changed while real time passed')
  })

  // Mutation: openCapturePage skips its syncAnimations; a page that jumps to 0.5 s starts #spin there, at 0 px.
  test('an animation started at load is anchored at virtual 0, so a jump matches a sweep', async () => {
    const swept = await openAnimations()
    for (const t of [0, 0.1, 0.2, 0.3, 0.4, 0.5]) await captureFrame(swept, t)
    const jumped = await openAnimations()

    await captureFrame(jumped, 0.5)

    // #glide is left out: a transition starts at the seek that triggers it, so it depends on the frames before.
    const { spin, late } = await offsets(swept)
    assert.deepEqual(await offsets(jumped), { spin, late, glide: 0 })
    assert.deepEqual({ spin, late }, { spin: 500, late: 200 })
  })

  // Mutation: fireTimers skips its syncAnimations; #late is first seen at 0.8 s and has not moved.
  test('an animation a timer starts is anchored at the timer, not at the next frame', async () => {
    const page = await openAnimations()

    await page.evaluate(() => window.__virtualTime.advanceTo(800))

    assert.equal((await offsets(page)).late, 500)
  })

  // Mutation: syncAnimations ignores pageOwned and drives every animation; the page's own seek is overwritten.
  test('an animation the page pauses and seeks itself is left to the page', async () => {
    const page = await openAnimations()
    await page.evaluate(() => {
      const spin = document.getElementById('spin')?.getAnimations()[0]
      if (!spin) throw new Error('no #spin animation')
      spin.pause()
      spin.currentTime = 123
    })

    await captureFrame(page, 0.5)

    assert.equal((await offsets(page)).spin, 123)
  })
})
