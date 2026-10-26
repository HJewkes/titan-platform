import assert from 'node:assert/strict'
import { launch } from '@titan-design/frame-capture'
import type { Browser, Page } from 'playwright-core'
import { afterAll as after, beforeAll as before, describe, test } from 'vitest'
import { serveFixtures, type Served } from './fixtures/serve-fixtures.js'
import { inspectAt, openQaPage } from './session.js'

const BROWSER_TIMEOUT_MS = 60_000

interface Fixture { id: string; kinds: string[] }

declare global {
  interface Window {
    /** The qa-fixtures page's list of fixtures and the kinds each must yield. */
    __qaFixtures?: Fixture[]
  }
}

let browser: Browser
let served: Served
let page: Page
let fixtures: Fixture[]

const kindsAt = async (id: string) => {
  const session = await openQaPage(browser, served.url('qa-fixtures', `?fixture=${id}`))
  try {
    const { findings } = await inspectAt(session.page, 0.5)
    return { kinds: [...new Set(findings.map((f) => f.kind))].sort(), findings }
  } finally {
    await session.page.context().close()
  }
}

before(async () => {
  served = await serveFixtures()
  browser = await launch()
  const first = await openQaPage(browser, served.url('qa-fixtures'))
  page = first.page
  fixtures = await page.evaluate(() => window.__qaFixtures ?? [])
  await page.context().close()
}, BROWSER_TIMEOUT_MS)

after(async () => {
  await browser.close()
  await served.close()
})

describe('qa-fixtures: each fixture yields exactly its finding kinds', { timeout: BROWSER_TIMEOUT_MS }, () => {
  test('every check has a bad fixture and a clean twin', () => {
    const checks = ['text-overlap', 'text-box', 'occluded', 'box-overlap', 'edge-through-pill', 'off-frame', 'content-overflow',
      'small-text', 'low-contrast', 'ellipsis', 'wrap', 'flex-wrap', 'flex-wrap-contents', 'crowding', 'anchor-offset', 'labels-dropped', 'edge-label-far', 'container', 'decor', 'camera',
      'double-chrome', 'under-chrome', 'fill-order', 'tone-mismatch', 'title-repeat', 'unlabelled-number', 'label-adjacent', 'misaligned']
    for (const check of checks) {
      assert.ok(fixtures.some((f) => f.id === `${check}-bad`), `${check}-bad`)
      assert.ok(fixtures.some((f) => f.id === `${check}-clean`), `${check}-clean`)
    }
  })

  test('the fixture list is non-trivial', () => {
    assert.ok(fixtures.length >= 30)
  })

  for (const id of ['text-overlap-bad', 'text-overlap-clean', 'text-overlap-ink-clean', 'text-box-bad', 'text-box-clean', 'occluded-bad',
    'occluded-clean', 'box-overlap-bad', 'box-overlap-clean', 'container-bad', 'container-clean', 'decor-bad', 'decor-clean',
    'edge-through-pill-bad', 'edge-through-pill-clean', 'off-frame-bad', 'off-frame-clean', 'content-overflow-bad', 'content-overflow-clean', 'content-overflow-ink-clean',
    'small-text-bad', 'small-text-clean', 'low-contrast-bad', 'low-contrast-clean', 'context-dim-clean', 'ellipsis-bad', 'ellipsis-clean',
    'wrap-bad', 'wrap-clean', 'flex-wrap-bad', 'flex-wrap-clean', 'flex-wrap-contents-bad', 'flex-wrap-contents-clean', 'crowding-bad',
    'crowding-clean', 'anchor-offset-bad', 'anchor-offset-clean', 'labels-dropped-bad', 'labels-dropped-clean', 'edge-label-far-bad', 'edge-label-far-clean', 'camera-bad', 'camera-clean', 'arrow-twins',
    ...['double-chrome', 'under-chrome', 'fill-order', 'tone-mismatch', 'title-repeat', 'unlabelled-number', 'label-adjacent', 'misaligned'].flatMap((k) => [`${k}-bad`, `${k}-clean`])]) {
    test(id, async () => {
      const want = fixtures.find((f) => f.id === id)
      assert.ok(want, `fixture ${id} exists`)
      const { kinds, findings } = await kindsAt(id)
      assert.deepEqual(kinds, [...want.kinds].sort(), JSON.stringify(findings.map((f) => [f.kind, f.text, f.other])))
    })
  }
})

describe('the cases the first probe got wrong', { timeout: BROWSER_TIMEOUT_MS }, () => {
  test('a tall stat value under its label is not a text overlap (ink band, not line box)', async () => {
    assert.deepEqual((await kindsAt('text-overlap-ink-clean')).kinds, [])
  })

  test('a stroke through the pill padding, clear of the glyphs, is an edge crossing', async () => {
    const { findings } = await kindsAt('edge-through-pill-bad')
    assert.equal(findings.filter((f) => f.kind === 'edge-crossing').length, 1)
    assert.equal(findings.find((f) => f.kind === 'edge-crossing')?.text, 'ref#2048')
  })

  test('a wrapping flex row built from display: contents wrappers is seen', async () => {
    const { findings } = await kindsAt('flex-wrap-contents-bad')
    assert.equal(findings.find((f) => f.kind === 'flex-wrap')?.rows, 2)
  })

  test('a pin 60 px from its anchor reports the offset', async () => {
    const { findings } = await kindsAt('anchor-offset-bad')
    const hit = findings.find((f) => f.kind === 'anchor-offset')
    assert.equal(hit?.dx, 60)
  })

  test('two identical arrows are two findings, told apart by their place on the page', async () => {
    const { findings } = await kindsAt('arrow-twins')
    assert.deepEqual(findings.filter((f) => f.kind === 'low-contrast').map((f) => f.twin), [0, 1])
  })

  // catches: reading scroll sizes alone, which held rail chips whose line box is 3 px taller than the chip
  test('a chip whose line box overhangs it but whose words sit inside is not an overflow', async () => {
    assert.deepEqual((await kindsAt('content-overflow-ink-clean')).kinds, [])
  })

  test('every finding carries the rectangle to annotate', async () => {
    const { findings } = await kindsAt('text-overlap-bad')
    assert.ok(findings.every((f) => f.at.w > 0 && f.at.h > 0))
  })
})
