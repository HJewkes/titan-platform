import assert from 'node:assert/strict'
import { launch } from '@titan-design/frame-capture'
import type { Browser } from 'playwright-core'
import { afterAll as after, beforeAll as before, describe, test } from 'vitest'
import { serveFixtures, type Served } from './fixtures/serve-fixtures.js'
import { inspectAt, openQaPage } from './session.js'

const BROWSER_TIMEOUT_MS = 60_000
/** The stage fixture's code card focuses line 1 from its start (1 s), so by 2.5 s lines 2-10 sit at the 35 % dim. */
const SETTLED_S = 2.5

let browser: Browser
let served: Served

before(async () => {
  served = await serveFixtures()
  browser = await launch()
}, BROWSER_TIMEOUT_MS)

after(async () => {
  await browser.close()
  await served.close()
})

describe('data-qa-context', { timeout: BROWSER_TIMEOUT_MS }, () => {
  test('dimmed code context raises no contrast error, and the focused line stays checked', async () => {
    const session = await openQaPage(browser, served.url('stage-fixture', '?code=10'))
    try {
      const { findings } = await inspectAt(session.page, SETTLED_S)
      const exempt = await session.page.$$eval('.ex-code-line', (lines) => lines.map((l) => l.hasAttribute('data-qa-context')))

      assert.deepEqual(findings.filter((f) => f.kind === 'low-contrast'), [])
      assert.deepEqual(exempt, [false, ...Array(9).fill(true)])
    } finally {
      await session.page.context().close()
    }
  })
})
