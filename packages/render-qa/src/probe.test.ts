import assert from 'node:assert/strict'
import { launch } from '@titan-design/frame-capture'
import type { Browser } from 'playwright-core'
import { afterAll as after, beforeAll as before, describe, test } from 'vitest'
import { serveFixtures, type Served } from './fixtures/serve-fixtures.js'
import { probeMoments, type ProbedMoment } from './probe.js'
import { openQaPage } from './session.js'

const BROWSER_TIMEOUT_MS = 60_000
const BAND = { x: 0, y: 0, width: 1920, height: 112 }

let browser: Browser
let served: Served
let empty: ProbedMoment
let filled: ProbedMoment

before(async () => {
  served = await serveFixtures()
  browser = await launch()
  const session = await openQaPage(browser, served.url('probe-fixture'))
  try {
    const [first, second] = await probeMoments(session.page, [{ beat: 'b1-clip', t: 0.5 }, { beat: 'b1-clip', t: 2 }])
    if (!first || !second) throw new Error('probeMoments returned fewer moments than it was given')
    empty = first
    filled = second
  } finally {
    await session.page.context().close()
  }
}, BROWSER_TIMEOUT_MS)

after(async () => {
  await browser.close()
  await served.close()
})

const textOf = (moment: ProbedMoment, element: string) => moment.texts.find((t) => t.element === element)

describe('probeMoments on the probe fixture', { timeout: BROWSER_TIMEOUT_MS }, () => {
  test('a three-line headline in a two-line overflow:hidden band has three line boxes and the band as a clip', () => {
    const headline = textOf(filled, 'h1.xp-headline')

    assert.ok(headline)
    const third = headline.lines[2]
    assert.equal(headline.lines.length, 3)
    assert.ok(headline.lines.every((line, i) => i === 0 || line.y > (headline.lines[i - 1]?.y ?? Infinity)), 'lines top to bottom')
    assert.deepEqual(headline.clips.find((c) => c.element === 'header.xp-band-top')?.box, BAND)
    assert.ok(third && third.y + third.height > BAND.height, 'the third line reaches past the band')
  })

  test('an element revealed through a clip-path inset lists the inset box as its own clip', () => {
    const label = textOf(filled, 'div.reveal')

    assert.ok(label)
    assert.deepEqual(label.clips.find((c) => c.element === 'div.reveal')?.box, { x: 960, y: 260, width: 400, height: 50 })
  })

  test('boxes are the elements that hold text or paint, with decor marked; empty layout wrappers are left out', () => {
    const elements = filled.boxes.map((b) => [b.element, b.decor === true])

    assert.deepEqual(elements, [['h1.xp-headline', false], ['div.card', false], ['span.card-label', false], ['div.marker', true], ['div.reveal', false]])
  })

  test('before the stage fills, only the chrome holds content, and each moment keeps its beat and time', () => {
    const moments = [empty, filled].map((m) => [m.beat, m.t])

    assert.deepEqual(empty.boxes.map((b) => b.element), ['h1.xp-headline'])
    assert.deepEqual(moments, [['b1-clip', 0.5], ['b1-clip', 2]])
  })
})

describe('probeMoments on the paint fixture', { timeout: BROWSER_TIMEOUT_MS }, () => {
  let painted: string[]

  before(async () => {
    const session = await openQaPage(browser, served.url('probe-paint-fixture'))
    try {
      const [moment] = await probeMoments(session.page, [{ beat: 'b1-paint', t: 0 }])
      painted = (moment?.boxes ?? []).map((b) => b.element)
    } finally {
      await session.page.context().close()
    }
  }, BROWSER_TIMEOUT_MS)

  test('rgb and rgba fills paint unless their alpha is 0', () => {
    assert.ok(painted.includes('div.swatch.rgb-opaque'))
    assert.ok(painted.includes('div.swatch.rgb-half'))
    assert.ok(!painted.includes('div.swatch.rgb-clear'))
  })

  test('a display-p3 fill paints opaque and at alpha 0.5, and not at alpha 0', () => {
    assert.ok(painted.includes('div.swatch.p3-opaque'))
    assert.ok(painted.includes('div.swatch.p3-half'))
    assert.ok(!painted.includes('div.swatch.p3-clear'))
  })

  test('an oklch fill with a percentage lightness paints at alpha 0.5, and not at alpha 0', () => {
    assert.ok(painted.includes('div.swatch.oklch-half'))
    assert.ok(!painted.includes('div.swatch.oklch-clear'))
  })
})
