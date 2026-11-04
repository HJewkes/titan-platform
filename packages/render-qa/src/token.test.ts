import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { launch } from '@titan-design/frame-capture'
import type { Browser } from 'playwright-core'
import { afterAll as after, beforeAll as before, describe, test } from 'vitest'
import { serveFixtures, type Served } from './fixtures/serve-fixtures.js'
import { buildMoments, type MomentBeat } from './moments.js'
import { inspectAt, openQaPage } from './session.js'

const BROWSER_TIMEOUT_MS = 120_000
/** b2-loop sends the flow token along the outer loop; routing it centre to centre would run it over node labels. */
const BEAT = 'b2-loop'
const SWEEP_STEP_S = 0.1

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

const sample: { beats: MomentBeat[] } = JSON.parse(readFileSync(new URL('./fixtures/samples/demo.words.json', import.meta.url), 'utf8'))
const beats = sample.beats
const startOf = (id: string) => beats.slice(0, beats.findIndex((b) => b.id === id)).reduce((s, b) => s + b.durationS, 0)

describe('a moving element over text', { timeout: BROWSER_TIMEOUT_MS }, () => {
  test('the flow token covers no text at b2-loop, at its gate moments or anywhere along its flight', async () => {
    const session = await openQaPage(browser, served.url('token'))
    try {
      const gate = buildMoments(beats, session.cues).filter((m) => m.beat === BEAT).map((m) => m.t)
      const beat = beats.find((b) => b.id === BEAT)
      if (!beat) throw new Error(`demo.words.json has no beat ${BEAT}`)
      const sweep = Array.from({ length: Math.floor(beat.durationS / SWEEP_STEP_S) }, (_, i) => startOf(BEAT) + i * SWEEP_STEP_S)
      const occluded: string[] = []
      for (const t of [...new Set([...gate, ...sweep])].sort((a, b) => a - b)) {
        const { findings } = await inspectAt(session.page, t)
        for (const f of findings) if (f.kind === 'occluded' && f.by?.includes('xp-token')) occluded.push(`${t.toFixed(2)} s: ${f.text}`)
      }

      assert.ok(gate.length >= 3, `only ${gate.length} gate moments`)
      assert.deepEqual(occluded, [])
    } finally {
      await session.page.context().close()
    }
  })
})
