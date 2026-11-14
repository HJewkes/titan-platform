import assert from 'node:assert/strict'
import type { Browser } from 'playwright-core'
import { afterAll as after, beforeAll as before, describe, test } from 'vitest'
import { captureFrame, launch, withCapturePage } from './capture.js'
import { serveFixtures, type Served } from './fixtures/serve-fixtures.js'
import { stills } from './stills.js'

const VIEWPORT = { width: 640, height: 360 }
const BROWSER_TIMEOUT_MS = 60_000

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

/** The frame at `t` on a page of its own, seeked to `t` alone. */
const alone = (t: number): Promise<Buffer> => withCapturePage(browser, served.url('clock'), VIEWPORT, ({ page }) => captureFrame(page, t))

describe('stills', { timeout: BROWSER_TIMEOUT_MS }, () => {
  // Mutations: stills seeks in the order asked (virtual time refuses to go back), or returns them in time order.
  test('takes moments asked out of order and returns each where it was asked, as a lone seek draws it', async () => {
    const shots = await stills({ ...VIEWPORT, url: served.url('clock'), browser }, [2, 0.5, 1.25])

    assert.deepEqual(shots, [await alone(2), await alone(0.5), await alone(1.25)])
    assert.notDeepEqual(shots[0], shots[1])
  })

  // Mutation: stills leaves its page's context open on the lent browser.
  test('closes its page on a lent browser and leaves the browser running', async () => {
    await stills({ ...VIEWPORT, url: served.url('clock'), browser }, [1])

    assert.ok(browser.isConnected())
    assert.equal(browser.contexts().length, 0)
  })
})
