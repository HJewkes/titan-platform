import assert from 'node:assert/strict'
import { test } from 'vitest'
import { classify, type SampledFrame } from './held.js'
import type { Finding } from './inspect.js'

const card = (parked: boolean): Finding => ({ kind: 'off-frame', el: 'div.card', text: 'Graph walk', at: { x: 1960, y: 300, w: 300, h: 100 }, ...(parked ? { parked: true } : {}) })
const frame = (beat: string, t: number, kind: SampledFrame['kind'], findings: Finding[]): SampledFrame =>
  ({ beat, local: t, t, kind, contentRuns: 5, findings })

// Mutation: excuseEntrances never excuses, so a card waiting for its cue is held off-frame again.
test('a card parked off frame until its cue is not off-frame once it enters', () => {
  const held = classify([
    frame('a', 1, 'cue', [card(true)]), frame('a', 1.5, 'mid', [card(true)]), frame('a', 2, 'mid', [card(true)]),
    frame('a', 3, 'mid', []), frame('a', 4, 'end', []),
  ])

  assert.equal(held.errors.length, 0)
  assert.equal(held.info.length, 0)
})

// Mutation: a parked finding is excused when the beat has any later sample, not one where the card is on frame.
test('a card that never enters the frame is still off-frame', () => {
  const held = classify([
    frame('a', 1, 'cue', [card(true)]), frame('a', 1.5, 'mid', [card(true)]), frame('a', 2, 'mid', [card(true)]),
    frame('a', 3, 'end', [card(true)]),
  ])

  assert.deepEqual(held.errors.map((e) => [e.kind, e.reason]), [['off-frame', 'held']])
})

test('a card that enters and is cut by the frame edge mid-slide is judged on that sample', () => {
  const held = classify([
    frame('a', 1, 'cue', [card(true)]), frame('a', 1.5, 'mid', [card(true)]), frame('a', 2, 'mid', [card(false)]), frame('a', 3, 'end', []),
  ])

  assert.deepEqual(held.info.map((e) => [e.kind, e.reason]), [['off-frame', 'transient']])
  assert.equal(held.errors.length, 0)
})

test('a card parked in one beat is not excused by another beat where it is on frame', () => {
  const held = classify([
    frame('a', 1, 'cue', [card(true)]), frame('a', 2, 'mid', [card(true)]), frame('a', 3, 'end', [card(true)]), frame('b', 4, 'mid', []),
  ])

  assert.equal(held.errors.length, 1)
})
