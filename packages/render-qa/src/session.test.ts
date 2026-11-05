import assert from 'node:assert/strict'
import { launch } from '@titan-design/frame-capture'
import type { Browser } from 'playwright-core'
import { afterAll as after, beforeAll as before, describe, test } from 'vitest'
import { serveFixtures, type Served } from './fixtures/serve-fixtures.js'
import { inspectAt, openQaPage } from './session.js'

const BROWSER_TIMEOUT_MS = 60_000

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

describe('inspectAt', { timeout: BROWSER_TIMEOUT_MS }, () => {
  // Mutation: inspectAt stops reading the page's errors, so the emptied stage inspects clean.
  test('a page that throws on a seek fails inspection instead of inspecting a blank frame', async () => {
    const session = await openQaPage(browser, served.url('stage-fixture', '?rows=8'))
    try {
      await assert.rejects(inspectAt(session.page, 2.5), /^Error: page error at 2\.50 s: stage-fixture overflows its stage box by \d+ px/)
    } finally {
      await session.page.context().close()
    }
  })

  test('a page that renders cleanly inspects as before', async () => {
    const session = await openQaPage(browser, served.url('stage-fixture', '?rows=4'))
    try {
      const { contentRuns } = await inspectAt(session.page, 2.5)
      assert.ok(contentRuns > 0)
    } finally {
      await session.page.context().close()
    }
  })
})

describe('openQaPage cues', { timeout: BROWSER_TIMEOUT_MS }, () => {
  test('cues the caller passes replace the page\'s own cue log', async () => {
    const cues = [{ beat: 'b2-loop', word: 'runs', nth: 1, atS: 1.4 }]

    const session = await openQaPage(browser, served.url('token'), undefined, cues)

    try {
      assert.deepEqual(session.cues, cues)
    } finally {
      await session.page.context().close()
    }
  })

  test('without cues, the session reads the page\'s __cueLog, and a page with none has no cues', async () => {
    const logged = await openQaPage(browser, served.url('token'))
    const unlogged = await openQaPage(browser, served.url('stage-fixture', '?rows=4'))

    try {
      assert.deepEqual([logged.cues.map((c) => `${c.word}@${c.atS}`), unlogged.cues], [['a@0.3', 'token@0.7', 'runs@1.4', 'the@1.9', 'loop@2.3'], []])
    } finally {
      await logged.page.context().close()
      await unlogged.page.context().close()
    }
  })
})
