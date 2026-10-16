import assert from 'node:assert/strict'
import type { Browser, Page } from 'playwright-core'
import { afterAll as after, beforeAll as before, describe, test } from 'vitest'
import { captureFrame, launch, openCapturePage, settleFonts } from './capture.js'
import { serveFixtures, type Served } from './fixtures/serve-fixtures.js'
import { VIRTUAL_TIME_SCRIPT } from './virtual-time.js'

const FPS = 30
const FRAMES = 31
const VIEWPORT = { width: 1920, height: 1080 }
const BROWSER_TIMEOUT_MS = 60_000

let served: Served
let browser: Browser
let reference: Page

/** The static page, its text set by hand: what frame i must look like, with no motion code involved. */
async function openReference(): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })
  await context.addInitScript({ content: VIRTUAL_TIME_SCRIPT })
  const page = await context.newPage()
  await page.goto(served.url('static-clock'), { waitUntil: 'load' })
  await page.locator('#stage').waitFor()
  await settleFonts(page)
  return page
}

async function referenceFrame(text: string): Promise<Buffer> {
  await reference.evaluate((value) => {
    const el = document.getElementById('stage')
    if (el) el.textContent = value
  }, text)
  return reference.screenshot({ type: 'png', caret: 'hide' })
}

/** Frame indices whose capture differs from the reference text `(i / 30).toFixed(3)`. */
async function mismatchedFrames(page: Page): Promise<number[]> {
  const mismatched: number[] = []
  for (let i = 0; i < FRAMES; i++) {
    const frame = await captureFrame(page, i / FPS)
    if (!frame.equals(await referenceFrame((i / FPS).toFixed(3)))) mismatched.push(i)
  }
  return mismatched
}

before(async () => {
  served = await serveFixtures()
  browser = await launch()
  reference = await openReference()
}, BROWSER_TIMEOUT_MS)

after(async () => {
  await browser.close()
  await served.close()
})

describe('capture clock', { timeout: BROWSER_TIMEOUT_MS }, () => {
  // Mutation: settleFonts drops the explicit face.load(); the page cannot open, so no frame matches.
  test('frame i of the clock page shows i/30 to three places', async () => {
    const { page } = await openCapturePage(browser, served.url('clock'), VIEWPORT)

    const mismatched = await mismatchedFrames(page)

    assert.deepEqual(mismatched, [])
  })

  // Mutation: referenceFrame ignores its text; every reference is the same frame.
  test('the reference frames differ from each other, so a frozen page cannot pass', async () => {
    const first = await referenceFrame((0).toFixed(3))
    const second = await referenceFrame((1 / FPS).toFixed(3))

    assert.notDeepEqual(first, second)
  })

  // Mutation: captureFrame calls advanceTo after seek; the deferred commit lands in its own frame and nothing is caught.
  test('a seek that commits after ready() resolves is caught on every frame after the first', async () => {
    const { page } = await openCapturePage(browser, served.url('clock'), VIEWPORT)
    await page.evaluate(() => {
      const motion = window.__titanMotion
      if (!motion) throw new Error('no __titanMotion')
      const commit = motion.seek
      motion.seek = (t) => void setTimeout(() => commit(t), 0)
    })

    const mismatched = await mismatchedFrames(page)

    assert.deepEqual(mismatched, Array.from({ length: FRAMES - 1 }, (_, i) => i + 1))
  })

  // Mutation: settleFonts drops the explicit face.load(); the face the page has not drawn yet stays unloaded.
  test('the capture page loads its fonts instead of a fallback', async () => {
    const { fonts } = await openCapturePage(browser, served.url('clock'), VIEWPORT)

    assert.deepEqual(
      fonts.map((f) => `${f.family}:${f.status}`),
      ['Space Grotesk:loaded', 'Unused Face:loaded']
    )
  })
})
