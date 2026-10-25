import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, test } from 'vitest'
import { sweepMoments, type MomentBeat } from './moments.js'

/** The archived sweep's OutroBeat rule: the outro fades its content out over its last second. */
const OUTRO_FADE_S = 1
const SCRIPTS = ['redesign-explainer-v4', 'review-addendum-v5'] as const

interface GoldenBeat extends MomentBeat {
  render: string
}

const read = (path: string): string => readFileSync(new URL(`./fixtures/sweep/${path}`, import.meta.url), 'utf8')
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const provenance: { scripts: Record<string, { beatsSha256: string; outputSha256: string }> } = JSON.parse(read('provenance.json'))
const outroSettle = (beat: GoldenBeat): number => (beat.render === 'OutroBeat' ? OUTRO_FADE_S : 0)

describe('sweepMoments against the archived sweep golden', () => {
  for (const script of SCRIPTS) {
    test(`${script}: the 2 Hz sweep with the outro fade rule equals the golden`, () => {
      const { beats }: { beats: GoldenBeat[] } = JSON.parse(read(`${script}/beats.json`))
      const golden = JSON.parse(read(`${script}/sweep_moments.json`))

      const moments = sweepMoments(beats, { settleBy: outroSettle })

      assert.deepEqual({ moments }, golden)
    })

    test(`${script}: the fixture copy is the captured golden`, () => {
      const recorded = provenance.scripts[script]

      const actual = { beatsSha256: sha256(read(`${script}/beats.json`)), outputSha256: sha256(read(`${script}/sweep_moments.json`)) }

      assert.deepEqual(actual, { beatsSha256: recorded?.beatsSha256, outputSha256: recorded?.outputSha256 })
    })
  }
})

describe('sweepMoments', () => {
  test('the settled sample is the last one before end - settleBy, even when later samples fall in the fade', () => {
    const beats = [{ id: 'intro', durationS: 2.2 }, { id: 'outro', durationS: 3.1 }]

    const moments = sweepMoments(beats, { settleBy: (beat) => (beat.id === 'outro' ? 1 : 0) })

    assert.deepEqual(moments.filter((m) => m.beat === 'outro').map((m) => [m.t, m.kind]), [[2.5, 'cue'], [3, 'cue'], [3.5, 'cue'], [4, 'end'], [4.5, 'cue'], [5, 'cue']])
  })

  test('without settleBy every beat settles on its last sample', () => {
    const moments = sweepMoments([{ id: 'a', durationS: 2.2 }, { id: 'b', durationS: 1.3 }])

    assert.deepEqual(moments.filter((m) => m.kind === 'end').map((m) => [m.beat, m.t]), [['a', 2], ['b', 3]])
  })

  test('the grid counts from the video start, so a beat starting between samples begins at the next one', () => {
    const moments = sweepMoments([{ id: 'a', durationS: 0.7 }, { id: 'b', durationS: 1 }])

    assert.deepEqual(moments.filter((m) => m.beat === 'b').map((m) => [m.t, m.local]), [[1, 0.3], [1.5, 0.8]])
  })

  test('a rate that is not a positive number is refused instead of looping or sampling nothing', () => {
    const beats = [{ id: 'a', durationS: 1 }]

    const attempts = [0, -2, Number.NaN, Infinity].map((hz) => () => sweepMoments(beats, { hz }))

    for (const attempt of attempts) assert.throws(attempt, RangeError)
  })

  test('a settle window longer than the beat falls back to its last sample', () => {
    const moments = sweepMoments([{ id: 'a', durationS: 1.2 }], { settleBy: () => 5 })

    assert.deepEqual(moments.map((m) => m.kind), ['cue', 'cue', 'end'])
  })
})
