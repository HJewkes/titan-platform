import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'
import { buildMoments } from './moments.js'

const demo: { beats: { id: string; durationS: number }[] } = JSON.parse(readFileSync(new URL('./fixtures/samples/demo.words.json', import.meta.url), 'utf8'))

test('a cue moment is 0.9 s after the cue, and the beat always has its middle and end', () => {
  const moments = buildMoments([{ id: 'a', durationS: 10 }], [{ beat: 'a', atS: 2 }])

  assert.deepEqual(moments.map((m) => [m.kind, m.local]), [['start', 0], ['enter', 0.3], ['cue', 2.9], ['mid', 5], ['end', 9.8]])
})

test('a cue near the end is clamped to 0.2 s before the beat ends, and merged with the end moment', () => {
  const moments = buildMoments([{ id: 'a', durationS: 10 }], [{ beat: 'a', atS: 9.5 }])

  assert.deepEqual(moments.map((m) => [m.kind, m.local]), [['start', 0], ['enter', 0.3], ['mid', 5], ['end', 9.8]])
})

test('cues closer than 0.6 s collapse to the first; 0.6 s apart both stay', () => {
  const close = buildMoments([{ id: 'a', durationS: 20 }], [{ beat: 'a', atS: 1 }, { beat: 'a', atS: 1.5 }])
  const apart = buildMoments([{ id: 'a', durationS: 20 }], [{ beat: 'a', atS: 1 }, { beat: 'a', atS: 1.6 }])

  assert.equal(close.filter((m) => m.kind === 'cue').length, 1)
  assert.equal(apart.filter((m) => m.kind === 'cue').length, 2)
})

test('the middle stays when a cue lands on it', () => {
  const moments = buildMoments([{ id: 'a', durationS: 10 }], [{ beat: 'a', atS: 4.1 }])

  assert.deepEqual(moments.map((m) => m.kind), ['start', 'enter', 'mid', 'end'])
})

test('later beats start after the earlier ones: b5-stats mid is at 59.12 s on the demo sample', () => {
  const moments = buildMoments(demo.beats, [])
  const mid = moments.find((m) => m.beat === 'b5-stats' && m.kind === 'mid')

  assert.ok(mid)
  assert.ok(Math.abs(mid.t - 59.12) < 0.005, String(mid.t))
})

test('moments of every demo beat are inside the video, in time order', () => {
  const moments = buildMoments(demo.beats, [])
  const total = demo.beats.reduce((s, b) => s + b.durationS, 0)

  assert.equal(moments.length, demo.beats.length * 4)
  assert.ok(moments.every((m, i) => m.t >= 0 && m.t < total && (i === 0 || m.t >= (moments[i - 1]?.t ?? -Infinity))))
})

// catches: sampling no beat boundary, so the one frame where two beats' chrome overprinted was never looked at
test('every beat is looked at on its first frame, where the beat before ends', () => {
  const moments = buildMoments(demo.beats, [])
  let startS = 0
  const starts = demo.beats.map((b) => { const t = startS; startS += b.durationS; return t })

  assert.deepEqual(moments.filter((m) => m.kind === 'start').map((m) => m.t), starts)
})
