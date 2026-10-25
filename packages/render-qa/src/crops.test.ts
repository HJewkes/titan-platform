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
})
