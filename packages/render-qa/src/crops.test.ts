import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launch } from '@titan-design/frame-capture'
import type { Browser } from 'playwright-core'
import { afterAll as after, beforeAll as before, describe, test } from 'vitest'
import { writeCrops, type CroppedFinding } from './crops.js'
import { serveFixtures, type Served } from './fixtures/serve-fixtures.js'
import { addLateFill, classify, countByKind, type SampledFrame } from './held.js'
import { DEFAULT_OPTIONS } from './inspect.js'
import { buildMoments } from './moments.js'
import { inspectAt, openQaPage } from './session.js'

const BROWSER_TIMEOUT_MS = 60_000
/** The qa-fixtures page with no `fixture` shows its first bad fixture, a text overlap, for its whole 3 s. */
const BEATS = [{ id: 'fixture', durationS: 3 }]

let browser: Browser
let served: Served
let out: string

before(async () => {
  out = mkdtempSync(`${tmpdir()}/render-qa-crops-`)
  served = await serveFixtures()
  browser = await launch()
}, BROWSER_TIMEOUT_MS)

after(async () => {
  await browser.close()
  await served.close()
  rmSync(out, { recursive: true, force: true })
})

/** The gate as a stage composes it: cue moments, an inspection at each, late-fill, the persistence rule, then crops. */
async function gate(url: string, dir: string) {
  const { page, cues } = await openQaPage(browser, url)
  const frames: SampledFrame[] = []
  try {
    for (const m of buildMoments(BEATS, cues)) {
      const { contentRuns, findings } = await inspectAt(page, m.t)
      frames.push({ beat: m.beat, local: m.local, t: m.t, kind: m.kind, contentRuns, findings })
    }
  } finally {
    await page.context().close()
  }
  addLateFill(frames, cues, new Map(BEATS.map((b) => [b.id, b.durationS])))
  const errors: CroppedFinding[] = classify(frames).errors
  await writeCrops(browser, url, errors, dir, DEFAULT_OPTIONS)
  return { pass: errors.length === 0, errorCounts: countByKind(errors), errors }
}

describe('writeCrops', { timeout: BROWSER_TIMEOUT_MS }, () => {
  test('the gate holds errors by kind and writes an annotated crop for each', async () => {
    const report = await gate(served.url('qa-fixtures'), `${out}/qa`)

    assert.equal(report.pass, false)
    assert.ok((report.errorCounts['text-overlap'] ?? 0) >= 1)
    const crops = readdirSync(`${out}/qa`)
    assert.equal(crops.length, report.errors.length)
    assert.ok(report.errors.every((e) => e.crop !== undefined && existsSync(`${out}/qa/${e.crop}`)))
  })

  test('a held finding wholly past the right edge is reported, not crashed on', async () => {
    const held = offFrame({ x: 2000, y: 100, w: 300, h: 200 })

    await writeCrops(browser, served.url('qa-fixtures'), [held], `${out}/right`, DEFAULT_OPTIONS)

    assert.ok(held.crop !== undefined && existsSync(`${out}/right/${held.crop}`))
  })

  test('held findings wholly past the top and left edges are reported, not crashed on', async () => {
    const above = offFrame({ x: 100, y: -600, w: 300, h: 200 })
    const left = offFrame({ x: -900, y: 100, w: 300, h: 200 })

    await writeCrops(browser, served.url('qa-fixtures'), [above, left], `${out}/topleft`, DEFAULT_OPTIONS)

    assert.ok([above, left].every((e) => e.crop !== undefined && existsSync(`${out}/topleft/${e.crop}`)))
  })
})

function offFrame(at: { x: number; y: number; w: number; h: number }): CroppedFinding {
  return { kind: 'off-frame', beat: 'fixture', finding: { kind: 'off-frame', el: 'div.card', at }, ts: [1], samples: 1, reason: 'held' }
}
